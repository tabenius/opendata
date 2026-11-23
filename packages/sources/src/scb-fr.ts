/**
 * SCB allmänna företagsregistret API (free since 26 June 2025).
 * Base https://apiafr.scb.se/v1, header X-API-Key, at most 5 calls/s per key,
 * cursor paging: `?limit=N&cursorId=C` -> { pagination: { hasMore, nextCursorId } }.
 *
 * Endpoints and field names follow SCB's variable description and observed
 * public client code (Luleå kommun's arbetsplatser_naringsliv). Fields not
 * listed there are read defensively and may be absent.
 *
 * Privacy: legal units with jurform 10 (fysiska personer) or 91 (dödsbon) and
 * any peOrgNr that is not a legal-entity number are dropped by the repository.
 */
import type { LegalUnitRow, WorkplaceRow } from "./scb-fr-types";
import { PoliteFetcher, type PoliteFetchOptions } from "./http";
import type { OrganisationRecord, WorkplaceRecord } from "@opendata/core";
export type { LegalUnitRow, WorkplaceRow };

export const SCB_FR_BASE = "https://apiafr.scb.se/v1";
export const SCB_FR_PAGE = 2000;

interface PageBody {
  pagination?: { hasMore?: boolean; nextCursorId?: number | null };
  arbetsstallen?: WorkplaceRow[];
  jes?: LegalUnitRow[];
}

export interface ScbFrOptions extends Partial<PoliteFetchOptions> {
  apiKey: string;
  baseUrl?: string;
}

export class ScbFrClient {
  private readonly http: PoliteFetcher;
  private readonly base: string;
  constructor(private readonly options: ScbFrOptions) {
    if (!options.apiKey) throw new TypeError("SCB API key is required");
    this.http = new PoliteFetcher({ minIntervalMs: 250, ...options });
    this.base = (options.baseUrl ?? SCB_FR_BASE).replace(/\/$/, "");
  }

  get calls() {
    return this.http.callCount;
  }

  private get<T>(path: string): Promise<T> {
    return this.http.json<T>(`${this.base}${path}`, { headers: { "X-API-Key": this.options.apiKey, Accept: "application/json" } });
  }

  async count(path: string): Promise<number> {
    const body = await this.get<unknown>(`${path}/count`);
    if (typeof body === "number") return body;
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) if (["count", "total", "totalcount", "antal"].includes(k.toLowerCase()) && typeof v === "number") return v;
    }
    throw new TypeError("unexpected count response");
  }

  /** Every row under a list endpoint, following cursors; refuses repeated cursors. */
  async *pages<T>(path: string, rowsKey: "arbetsstallen" | "jes", limit = SCB_FR_PAGE): AsyncGenerator<T[]> {
    let cursor: number | undefined;
    const seen = new Set<number>();
    for (;;) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor !== undefined) query.set("cursorId", String(cursor));
      const body = await this.get<PageBody>(`${path}?${query}`);
      const rows = body[rowsKey];
      if (!Array.isArray(rows)) throw new TypeError(`SCB response lacks ${rowsKey}`);
      yield rows as T[];
      const next = body.pagination?.nextCursorId;
      if (body.pagination?.hasMore !== true) return;
      if (typeof next !== "number" || seen.has(next)) throw new TypeError("invalid or repeated SCB cursor");
      seen.add(next);
      cursor = next;
    }
  }

  workplacesInKommun(kommun: string) {
    assertCode(kommun, 4);
    return this.pages<WorkplaceRow>(`/arbetsstallen/kommun/${kommun}`, "arbetsstallen");
  }

  legalUnitsInKommun(kommun: string) {
    assertCode(kommun, 4);
    return this.pages<LegalUnitRow>(`/juridiskaenheter/kommun/${kommun}`, "jes");
  }

  legalUnitsInLan(lan: string) {
    assertCode(lan, 2);
    return this.pages<LegalUnitRow>(`/juridiskaenheter/lan/${lan}`, "jes");
  }

  legalUnit(peOrgNr: string) {
    if (!/^\d{10,12}$/.test(peOrgNr)) throw new TypeError("invalid peOrgNr");
    return this.get<LegalUnitRow>(`/juridiskaenheter/${peOrgNr}`);
  }
}

function assertCode(code: string, digits: number) {
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) throw new TypeError(`expected a ${digits}-digit region code`);
}

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v).trim());

function sniOf(value: unknown): { code: string | null; division: string | null } {
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return { code: str(o.naringsgren ?? o.kod), division: str(o.avdelningsKod) };
  }
  return { code: str(value), division: null };
}

function nameOf(value: unknown): string | null {
  if (value && typeof value === "object") return str((value as Record<string, unknown>).namn);
  return str(value);
}

export function mapLegalUnit(row: LegalUnitRow, sourceDate: string): OrganisationRecord | null {
  const name = nameOf(row.namn) ?? str(row.foretagsnamn);
  const orgnr = str(row.peOrgNr);
  if (!orgnr || !name) return null;
  const post = row.postAdress ?? undefined;
  const sni = sniOf(row.primarNaringsgren ?? row.ng1);
  return {
    orgnr,
    name,
    jurform: str(row.jurform),
    legalForm: null,
    status: row.jeStat === 1 || row.jeStat === "1" ? "active" : row.jeStat === 9 || row.jeStat === "9" ? "inactive" : "unknown",
    post: post ? { street: str(post.gatuAdress), postcode: str(post.postNr), town: str(post.postOrt) } : undefined,
    sniPrimary: sni.code,
    adBlock: String(row.reklamSparrTyp ?? "") === "2",
    source: "scb-fr",
    sourceDate,
  };
}

export function mapWorkplace(row: WorkplaceRow, sourceDate: string, jurform: (orgnr: string) => string | null | undefined): WorkplaceRecord | null {
  const orgnr = str(row.peOrgNr);
  if (typeof row.cfarNr !== "number" || !orgnr) return null;
  const sni = sniOf(row.primarNaringsgren);
  const b = row.belagenhetsadress ?? undefined;
  const p = row.postAdress ?? undefined;
  return {
    cfar: row.cfarNr,
    orgnr,
    name: str(row.ben),
    sni: sni.code,
    sniDivision: sni.division,
    sizeClass: str(row.anstKl),
    status: str(row.aeStat),
    visit: b ? { street: str(b.bGatuAdress), postcode: str(b.bPostNr), town: str(b.bPostOrt) } : undefined,
    kommun: b ? str(b.kommun) : null,
    lan: b ? str(b.lan) : null,
    post: p ? { street: str(p.gatuAdress), postcode: str(p.postNr), town: str(p.postOrt) } : undefined,
    adBlock: String(row.reklamSparrTyp ?? "") === "2",
    sourceDate,
    jurform: jurform(orgnr) ?? null,
  };
}
