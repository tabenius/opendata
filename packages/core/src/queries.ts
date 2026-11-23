/**
 * Read side, shared by GraphQL, MCP and the PWA's API. Every result carries
 * its sources so attribution can be shown. Nothing here can return a natural
 * person: those rows are never written (repository.ts).
 */
import { parseObjectKey, type ObjectStore, type SqlStore, type SqlValue } from "@opendata/ports";
import { addressLabel, matchKey, normalisePostcode, normaliseText, parseStreetAddress } from "./address";
import { decodeCursor, encodeCursor } from "./cursor";
import { cellRanges, haversineMeters, inSweden, type LatLon, MAX_RADIUS_M } from "./geo";
import { formatOrgnr, parseOrgnr } from "./orgnr";
import { containsPoint, type Geometry } from "./polygon";
import { SOURCES, type SourceInfo } from "./sources";

export const MAX_PAGE = 100;
/** Nearest candidates considered per proximity query (pagination stays within them). */
export const MAX_NEAR_CANDIDATES = 5000;

export interface Address {
  street: string | null;
  postcode: string | null;
  town: string | null;
}

export interface Organisation {
  orgnr: string;
  orgnrFormatted: string;
  name: string;
  legalForm: string | null;
  legalFormCode: string | null;
  status: string;
  registeredAt: string | null;
  deregisteredAt: string | null;
  deregistrationReason: string | null;
  businessDescription: string | null;
  postAddress: Address;
  sniPrimary: string | null;
  sniCodes: string[];
  adBlock: boolean;
  sources: SourceInfo[];
  sourceDate: string;
}

export interface Workplace {
  cfar: number;
  orgnr: string;
  name: string | null;
  organisationName: string | null;
  sni: string | null;
  sizeClass: string | null;
  status: string | null;
  visitAddress: Address;
  kommun: string | null;
  lan: string | null;
  location: LatLon | null;
  geocodeQuality: string | null;
  adBlock: boolean;
  distanceM: number | null;
  sourceDate: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  totalEstimate?: number;
}

export interface GeocodeResult {
  addressId: string;
  label: string;
  street: string;
  number: string | null;
  letter: string | null;
  postcode: string | null;
  town: string | null;
  kommun: string | null;
  location: LatLon;
  deso: string | null;
}

export interface AreaStat {
  tableId: string;
  variable: string;
  label: string | null;
  period: string;
  value: number | null;
}

export interface Area {
  deso: string;
  regso: string | null;
  kommun: string | null;
  name: string | null;
  centroid: LatLon | null;
  stats: AreaStat[];
  workplaceCount: number;
}

export interface AnnualReport {
  documentId: string;
  orgnr: string;
  periodEnd: string | null;
  registeredAt: string | null;
  format: string | null;
  objectKey: string | null;
  sha256: string | null;
  sizeBytes: number | null;
}

export interface SourceStatus extends SourceInfo {
  lastRun: { startedAt: string; finishedAt: string | null; status: string; rows: number; skippedNaturalPersons: number } | null;
}

type OrgRow = Record<string, unknown> & { orgnr: string; sni_codes: string | null; sources: string };
type WpRow = Record<string, unknown> & { cfar: number; lat: number | null; lon: number | null };

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toOrganisation(r: OrgRow): Organisation {
  return {
    orgnr: r.orgnr,
    orgnrFormatted: formatOrgnr(r.orgnr),
    name: String(r.name),
    legalForm: s(r.legal_form),
    legalFormCode: s(r.legal_form_code),
    status: String(r.status),
    registeredAt: s(r.registered_at),
    deregisteredAt: s(r.deregistered_at),
    deregistrationReason: s(r.deregistration_reason),
    businessDescription: s(r.business_description),
    postAddress: { street: s(r.post_street), postcode: s(r.post_postcode), town: s(r.post_town) },
    sniPrimary: s(r.sni_primary),
    sniCodes: r.sni_codes ? (JSON.parse(r.sni_codes) as string[]) : [],
    adBlock: Number(r.ad_block) === 1,
    sources: r.sources.split(",").filter((id) => id in SOURCES).map((id) => SOURCES[id as keyof typeof SOURCES]),
    sourceDate: String(r.source_date),
  };
}

function toWorkplace(r: WpRow, distanceM: number | null = null): Workplace {
  return {
    cfar: Number(r.cfar),
    orgnr: String(r.orgnr),
    name: s(r.name),
    organisationName: s(r.organisation_name),
    sni: s(r.sni),
    sizeClass: s(r.size_class),
    status: s(r.status),
    visitAddress: { street: s(r.visit_street), postcode: s(r.visit_postcode), town: s(r.visit_town) },
    kommun: s(r.kommun),
    lan: s(r.lan),
    location: r.lat !== null && r.lon !== null ? { lat: Number(r.lat), lon: Number(r.lon) } : null,
    geocodeQuality: s(r.geocode_quality),
    adBlock: Number(r.ad_block) === 1,
    distanceM: distanceM === null ? null : Math.round(distanceM),
    sourceDate: String(r.source_date),
  };
}

function clampFirst(first: number | undefined, fallback = 20): number {
  const n = first ?? fallback;
  if (!Number.isInteger(n) || n < 1) throw new RangeError("first must be a positive integer");
  return Math.min(n, MAX_PAGE);
}

/** Input rules shared by GraphQL, REST and MCP. RangeError = the caller's mistake. */
export const INPUT = {
  sni: /^\d{1,5}$/,
  kommun: /^\d{4}$/,
  deso: /^\d{4}[A-C]\d{4}$/,
  legalFormCode: /^[A-ZÅÄÖ]{1,5}$/,
  status: /^(active|inactive|deregistered|unknown)$/,
} as const;

function check(name: keyof typeof INPUT, value: string | undefined | null): void {
  if (value !== undefined && value !== null && !INPUT[name].test(value)) throw new RangeError(`invalid ${name}`);
}

function checkText(name: string, value: string | undefined, max: number): void {
  if (value !== undefined && (value.length > max || /[\u0000-\u001f]/.test(value))) throw new RangeError(`${name} must be at most ${max} printable characters`);
}

function checkPoint(p: LatLon | undefined): void {
  if (p && !(Number.isFinite(p.lat) && Number.isFinite(p.lon))) throw new RangeError("point must have finite lat and lon");
}

/** FTS5 query from free text: quoted prefix terms, AND-ed. */
export function ftsQuery(text: string): string | null {
  const terms = normaliseText(text)
    .split(" ")
    .map((t) => t.replace(/["*^():]/g, ""))
    .filter((t) => t.length > 0)
    .slice(0, 8);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" ") : null;
}

export interface OrganisationFilter {
  query?: string;
  sni?: string;
  town?: string;
  kommun?: string;
  legalFormCode?: string;
  status?: string;
}

export interface NearOptions {
  point?: LatLon;
  address?: string;
  radiusM?: number;
  sni?: string[];
  first?: number;
  after?: string | null;
}

export class Queries {
  constructor(
    private readonly sql: SqlStore,
    private readonly objects?: ObjectStore,
  ) {}

  async organisation(orgnr: string): Promise<(Organisation & { workplaceCount: number }) | null> {
    let id: string;
    try {
      id = parseOrgnr(orgnr);
    } catch {
      return null;
    }
    const row = await this.sql.first<OrgRow>("SELECT * FROM organisation WHERE orgnr = ?", [id]);
    if (!row) return null;
    const count = await this.sql.first<{ c: number }>("SELECT count(*) AS c FROM workplace WHERE orgnr = ?", [id]);
    return { ...toOrganisation(row), workplaceCount: Number(count?.c ?? 0) };
  }

  async searchOrganisations(filter: OrganisationFilter, first?: number, after?: string | null): Promise<Page<Organisation>> {
    checkText("query", filter.query, 100);
    checkText("town", filter.town, 60);
    check("sni", filter.sni);
    check("kommun", filter.kommun);
    check("legalFormCode", filter.legalFormCode);
    check("status", filter.status);
    const limit = clampFirst(first);
    const where: string[] = [];
    const params: SqlValue[] = [];
    let from = "organisation o";
    const fts = filter.query ? ftsQuery(filter.query) : null;
    if (filter.query && !fts) return { items: [], nextCursor: null };
    if (fts) {
      from = "organisation_fts f JOIN organisation o ON o.orgnr = f.orgnr";
      where.push("organisation_fts MATCH ?");
      params.push(fts);
    }
    if (filter.sni) {
      where.push("(o.sni_primary LIKE ? OR o.sni_codes LIKE ?)");
      params.push(`${filter.sni}%`, `%"${filter.sni}%`);
    }
    if (filter.town) {
      where.push("o.post_town = ?");
      params.push(normaliseText(filter.town));
    }
    if (filter.legalFormCode) {
      where.push("o.legal_form_code = ?");
      params.push(filter.legalFormCode);
    }
    if (filter.status) {
      where.push("o.status = ?");
      params.push(filter.status);
    }
    if (filter.kommun) {
      where.push("EXISTS (SELECT 1 FROM workplace w WHERE w.orgnr = o.orgnr AND w.kommun = ?)");
      params.push(filter.kommun);
    }
    const cursor = decodeCursor<{ o: string }>(after);
    if (cursor && (typeof cursor.o !== "string" || !/^\d{10}$/.test(cursor.o))) throw new RangeError("invalid cursor");
    if (cursor) {
      where.push("o.orgnr > ?");
      params.push(cursor.o);
    }
    const rows = await this.sql.query<OrgRow>(
      `SELECT o.* FROM ${from} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.orgnr LIMIT ?`,
      [...params, limit + 1],
    );
    const items = rows.slice(0, limit).map(toOrganisation);
    return { items, nextCursor: rows.length > limit ? encodeCursor({ o: items[items.length - 1]!.orgnr }) : null };
  }

  async workplacesOf(orgnr: string, first?: number, after?: string | null): Promise<Page<Workplace>> {
    const limit = clampFirst(first);
    const id = parseOrgnr(orgnr);
    const cursor = decodeCursor<{ c: number }>(after);
    if (cursor && !Number.isSafeInteger(cursor.c)) throw new RangeError("invalid cursor");
    const rows = await this.sql.query<WpRow>(
      `SELECT w.*, o.name AS organisation_name FROM workplace w LEFT JOIN organisation o ON o.orgnr = w.orgnr
       WHERE w.orgnr = ? AND w.cfar > ? ORDER BY w.cfar LIMIT ?`,
      [id, cursor?.c ?? -1, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => toWorkplace(r));
    return { items, nextCursor: rows.length > limit ? encodeCursor({ c: items[items.length - 1]!.cfar }) : null };
  }

  async geocode(text: string, limit = 5): Promise<GeocodeResult[]> {
    checkText("address", text, 200);
    const n = Math.min(Math.max(1, limit), 20);
    const toResult = (r: Record<string, unknown>): GeocodeResult => ({
      addressId: String(r.address_id),
      label: addressLabel({ street: String(r.street), number: s(r.number), letter: s(r.letter), postcode: s(r.postcode), town: s(r.town) }),
      street: String(r.street),
      number: s(r.number),
      letter: s(r.letter),
      postcode: s(r.postcode),
      town: s(r.town),
      kommun: s(r.kommun),
      location: { lat: Number(r.lat), lon: Number(r.lon) },
      deso: s(r.deso),
    });
    // Exact path: "Street 12B, 41664 Town"
    const [first, ...rest] = text.split(",");
    const parsed = parseStreetAddress(first ?? "");
    const postcode = normalisePostcode(rest.join(" ").match(/\d{3}\s?\d{2}/)?.[0]);
    if (parsed.number && postcode) {
      const exact = await this.sql.query("SELECT * FROM address WHERE match_key = ? LIMIT ?", [matchKey({ ...parsed, postcode }), n]);
      if (exact.length) return exact.map(toResult);
      if (!parsed.letter) {
        // "Storgatan 12" also matches 12A, 12B... at that postcode.
        const escaped = normaliseText(parsed.street).replace(/[\\%_]/g, "\\$&");
        const lettered = await this.sql.query(
          "SELECT * FROM address WHERE match_key LIKE ? ESCAPE '\\' ORDER BY match_key LIMIT ?",
          [`${escaped}|${parsed.number}_|${postcode}`, n],
        );
        if (lettered.length) return lettered.map(toResult);
      }
    }
    const fts = ftsQuery(text);
    if (!fts) return [];
    const rows = await this.sql.query(
      "SELECT a.* FROM address_fts f JOIN address a ON a.address_id = f.address_id WHERE address_fts MATCH ? ORDER BY rank LIMIT ?",
      [fts, n],
    );
    return rows.map(toResult);
  }

  async workplacesNear(options: NearOptions): Promise<Page<Workplace> & { center: LatLon | null }> {
    checkText("address", options.address, 200);
    checkPoint(options.point);
    if ((options.sni?.length ?? 0) > 10) throw new RangeError("at most 10 SNI prefixes");
    for (const code of options.sni ?? []) check("sni", code);
    const limit = clampFirst(options.first, 50);
    const radius = options.radiusM ?? 500;
    if (!(radius > 0 && radius <= MAX_RADIUS_M)) throw new RangeError(`radiusM must be 1..${MAX_RADIUS_M}`);
    let center = options.point ?? null;
    if (!center && options.address) center = (await this.geocode(options.address, 1))[0]?.location ?? null;
    if (!center) return { items: [], nextCursor: null, center: null };
    if (!inSweden(center)) throw new RangeError("point is outside Sweden");
    const ranges = cellRanges(center, radius);
    const where = ranges.map(() => "(w.cell BETWEEN ? AND ?)").join(" OR ");
    const params: SqlValue[] = ranges.flat();
    let sniClause = "";
    for (const code of (options.sni ?? []).slice(0, 10)) {
      sniClause += sniClause ? " OR w.sni LIKE ?" : "w.sni LIKE ?";
      params.push(`${code}%`);
    }
    // Order by an equirectangular distance in SQL before the cap, so the cap
    // drops the farthest candidates, never the nearest. Exact haversine below.
    const k = Math.cos((center.lat * Math.PI) / 180);
    const rows = await this.sql.query<WpRow>(
      `SELECT w.*, o.name AS organisation_name FROM workplace w LEFT JOIN organisation o ON o.orgnr = w.orgnr
       WHERE (${where}) ${sniClause ? `AND (${sniClause})` : ""}
       ORDER BY (w.lat - ?) * (w.lat - ?) + ((w.lon - ?) * ?) * ((w.lon - ?) * ?), w.cfar LIMIT ?`,
      [...params, center.lat, center.lat, center.lon, k, center.lon, k, MAX_NEAR_CANDIDATES],
    );
    const within = rows
      .map((r) => ({ r, d: haversineMeters(center!, { lat: Number(r.lat), lon: Number(r.lon) }) }))
      .filter((x) => x.d <= radius)
      .sort((a, b) => a.d - b.d || Number(a.r.cfar) - Number(b.r.cfar));
    const offset = decodeCursor<{ i: number }>(options.after)?.i ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("invalid cursor");
    const items = within.slice(offset, offset + limit).map((x) => toWorkplace(x.r, x.d));
    return {
      items,
      nextCursor: within.length > offset + limit ? encodeCursor({ i: offset + limit }) : null,
      totalEstimate: within.length,
      center,
    };
  }

  async area(input: { deso?: string; point?: LatLon }): Promise<Area | null> {
    check("deso", input.deso);
    checkPoint(input.point);
    let row: Record<string, unknown> | null = null;
    if (input.deso) {
      row = await this.sql.first("SELECT * FROM area WHERE deso = ?", [input.deso]);
    } else if (input.point) {
      const { lat, lon } = input.point;
      const candidates = await this.sql.query(
        "SELECT * FROM area WHERE min_lat <= ? AND max_lat >= ? AND min_lon <= ? AND max_lon >= ? LIMIT 50",
        [lat, lat, lon, lon],
      );
      for (const candidate of candidates) {
        let geometry: Geometry | null = null;
        if (typeof candidate.geometry === "string") geometry = JSON.parse(candidate.geometry) as Geometry;
        else if (s(candidate.geometry_key) && this.objects)
          geometry = JSON.parse(new TextDecoder().decode(await this.objects.get(parseObjectKey(String(candidate.geometry_key))))) as Geometry;
        if (geometry && containsPoint(geometry, lon, lat)) {
          row = candidate;
          break;
        }
      }
      if (!row && candidates.length && candidates.every((c) => c.geometry === null && c.geometry_key === null)) {
        // Without geometries, the nearest centroid among bbox candidates.
        row = candidates
          .filter((c) => c.lat !== null)
          .sort((a, b) => haversineMeters(input.point!, { lat: Number(a.lat), lon: Number(a.lon) }) - haversineMeters(input.point!, { lat: Number(b.lat), lon: Number(b.lon) }))[0] ?? null;
      }
    }
    if (!row) return null;
    const deso = String(row.deso);
    const stats = await this.sql.query<Record<string, unknown>>(
      "SELECT table_id, variable, label, period, value FROM area_stat WHERE deso = ? ORDER BY table_id, variable, period",
      [deso],
    );
    const count = await this.sql.first<{ c: number }>(
      "SELECT count(*) AS c FROM workplace w JOIN address a ON a.address_id = w.address_id WHERE a.deso = ?",
      [deso],
    );
    return {
      deso,
      regso: s(row.regso),
      kommun: s(row.kommun),
      name: s(row.name),
      centroid: row.lat !== null && row.lon !== null ? { lat: Number(row.lat), lon: Number(row.lon) } : null,
      stats: stats.map((r) => ({ tableId: String(r.table_id), variable: String(r.variable), label: s(r.label), period: String(r.period), value: r.value === null ? null : Number(r.value) })),
      workplaceCount: Number(count?.c ?? 0),
    };
  }

  async annualReports(orgnr: string): Promise<AnnualReport[]> {
    const id = parseOrgnr(orgnr);
    const rows = await this.sql.query<Record<string, unknown>>("SELECT * FROM annual_report WHERE orgnr = ? ORDER BY period_end DESC", [id]);
    return rows.map((r) => ({
      documentId: String(r.document_id),
      orgnr: String(r.orgnr),
      periodEnd: s(r.period_end),
      registeredAt: s(r.registered_at),
      format: s(r.format),
      objectKey: s(r.object_key),
      sha256: s(r.sha256),
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    }));
  }

  async sourceStatus(): Promise<SourceStatus[]> {
    const out: SourceStatus[] = [];
    for (const info of Object.values(SOURCES)) {
      if (info.id === "fixture") continue;
      const run = await this.sql.first<Record<string, unknown>>(
        "SELECT * FROM source_run WHERE source = ? ORDER BY started_at DESC LIMIT 1",
        [info.id],
      );
      out.push({
        ...info,
        lastRun: run
          ? { startedAt: String(run.started_at), finishedAt: s(run.finished_at), status: String(run.status), rows: Number(run.rows), skippedNaturalPersons: Number(run.skipped_natural_persons) }
          : null,
      });
    }
    return out;
  }

  async sni(code: string): Promise<{ code: string; title: string; version: string } | null> {
    return this.sql.first("SELECT code, title, version FROM sni WHERE code = ?", [code]);
  }
}
