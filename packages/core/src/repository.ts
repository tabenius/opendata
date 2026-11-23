/**
 * The single write path into the database. Every write passes the privacy
 * guard first; records that fail it are counted and dropped, never stored.
 */
import type { SqlStore, SqlValue, Statement } from "@opendata/ports";
import { matchKey, normalisePostcode, parseStreetAddress, addressLabel } from "./address";
import { cellOf, inSweden } from "./geo";
import { parseOrgnr } from "./orgnr";
import { classify } from "./privacy";
import type { AddressRecord, AnnualReportRecord, AreaRecord, AreaStatRecord, OrganisationRecord, WorkplaceRecord } from "./types";

export interface WriteReport {
  written: number;
  skippedNaturalPersons: number;
  skippedInvalid: number;
}

const empty = (): WriteReport => ({ written: 0, skippedNaturalPersons: 0, skippedInvalid: 0 });
const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Run statements in batches small enough for D1 limits. */
async function runBatches(sql: SqlStore, statements: Statement[], size = 50) {
  for (let i = 0; i < statements.length; i += size) await sql.batch(statements.slice(i, i + size));
}

export class Repository {
  constructor(private readonly sql: SqlStore, private readonly now: () => Date = () => new Date()) {}

  async upsertOrganisations(records: OrganisationRecord[]): Promise<WriteReport> {
    const report = empty();
    const statements: Statement[] = [];
    const updatedAt = this.now().toISOString();
    for (const r of records) {
      const cls = classify({ id: r.orgnr, jurform: r.jurform, bvForm: r.bvForm ?? r.legalFormCode, idType: r.idType });
      if (cls === "natural") {
        report.skippedNaturalPersons++;
        continue;
      }
      if (cls !== "legal") {
        report.skippedInvalid++;
        continue;
      }
      const orgnr = parseOrgnr(r.orgnr);
      const params: SqlValue[] = [
        orgnr,
        r.name,
        nn(r.legalForm),
        nn(r.legalFormCode),
        r.status ?? "unknown",
        nn(r.registeredAt),
        nn(r.deregisteredAt),
        nn(r.deregistrationReason),
        nn(r.businessDescription),
        nn(r.post?.street),
        normalisePostcode(r.post?.postcode) ?? null,
        nn(r.post?.town),
        nn(r.sniPrimary),
        r.sniCodes ? JSON.stringify(r.sniCodes) : null,
        r.adBlock ? 1 : 0,
        r.source,
        r.sourceDate,
        updatedAt,
      ];
      statements.push({
        sql: `INSERT INTO organisation (orgnr, name, legal_form, legal_form_code, status, registered_at, deregistered_at,
  deregistration_reason, business_description, post_street, post_postcode, post_town, sni_primary, sni_codes, ad_block,
  sources, source_date, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(orgnr) DO UPDATE SET
  name = excluded.name,
  legal_form = COALESCE(excluded.legal_form, legal_form),
  legal_form_code = COALESCE(excluded.legal_form_code, legal_form_code),
  status = CASE WHEN excluded.status = 'unknown' THEN status ELSE excluded.status END,
  registered_at = COALESCE(excluded.registered_at, registered_at),
  deregistered_at = COALESCE(excluded.deregistered_at, deregistered_at),
  deregistration_reason = COALESCE(excluded.deregistration_reason, deregistration_reason),
  business_description = COALESCE(excluded.business_description, business_description),
  post_street = COALESCE(excluded.post_street, post_street),
  post_postcode = COALESCE(excluded.post_postcode, post_postcode),
  post_town = COALESCE(excluded.post_town, post_town),
  sni_primary = COALESCE(excluded.sni_primary, sni_primary),
  sni_codes = COALESCE(excluded.sni_codes, sni_codes),
  ad_block = MAX(excluded.ad_block, ad_block),
  sources = CASE WHEN instr(',' || sources || ',', ',' || excluded.sources || ',') > 0 THEN sources ELSE sources || ',' || excluded.sources END,
  source_date = MAX(excluded.source_date, source_date),
  updated_at = excluded.updated_at`,
        params,
      });
      statements.push({ sql: "DELETE FROM organisation_fts WHERE orgnr = ?", params: [orgnr] });
      statements.push({ sql: "INSERT INTO organisation_fts (orgnr, name) SELECT orgnr, name FROM organisation WHERE orgnr = ?", params: [orgnr] });
      report.written++;
    }
    await runBatches(this.sql, statements, 60);
    return report;
  }

  /** Find coordinates for a postal address via Lantmäteriet location addresses. */
  async geocodeParts(street: string | null | undefined, postcode: string | null | undefined) {
    if (!street) return null;
    const parsed = parseStreetAddress(street);
    const pc = normalisePostcode(postcode);
    if (!parsed.number || !pc) return null;
    const exact = await this.sql.first<{ address_id: string; lat: number; lon: number; cell: number }>(
      "SELECT address_id, lat, lon, cell FROM address WHERE match_key = ? LIMIT 1",
      [matchKey({ ...parsed, postcode: pc })],
    );
    if (exact) return { ...exact, quality: "exact" as const };
    if (parsed.letter) {
      const noLetter = await this.sql.first<{ address_id: string; lat: number; lon: number; cell: number }>(
        "SELECT address_id, lat, lon, cell FROM address WHERE match_key = ? LIMIT 1",
        [matchKey({ street: parsed.street, number: parsed.number, postcode: pc })],
      );
      if (noLetter) return { ...noLetter, quality: "number" as const };
    }
    return null;
  }

  async upsertWorkplaces(records: WorkplaceRecord[]): Promise<WriteReport> {
    const report = empty();
    const statements: Statement[] = [];
    for (const r of records) {
      const cls = classify({ id: r.orgnr, jurform: r.jurform });
      if (cls === "natural") {
        report.skippedNaturalPersons++;
        continue;
      }
      if (cls !== "legal" || !Number.isSafeInteger(r.cfar)) {
        report.skippedInvalid++;
        continue;
      }
      const geo = await this.geocodeParts(r.visit?.street, r.visit?.postcode);
      statements.push({
        sql: `INSERT INTO workplace (cfar, orgnr, name, sni, sni_division, size_class, status, visit_street, visit_postcode, visit_town,
  kommun, lan, post_street, post_postcode, post_town, address_id, lat, lon, cell, geocode_quality, ad_block, source_date)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(cfar) DO UPDATE SET orgnr = excluded.orgnr, name = excluded.name, sni = excluded.sni, sni_division = excluded.sni_division,
  size_class = excluded.size_class, status = excluded.status, visit_street = excluded.visit_street, visit_postcode = excluded.visit_postcode,
  visit_town = excluded.visit_town, kommun = excluded.kommun, lan = excluded.lan, post_street = excluded.post_street,
  post_postcode = excluded.post_postcode, post_town = excluded.post_town, address_id = excluded.address_id, lat = excluded.lat,
  lon = excluded.lon, cell = excluded.cell, geocode_quality = excluded.geocode_quality, ad_block = excluded.ad_block,
  source_date = excluded.source_date`,
        params: [
          r.cfar,
          parseOrgnr(r.orgnr),
          nn(r.name),
          nn(r.sni),
          nn(r.sniDivision),
          nn(r.sizeClass),
          nn(r.status),
          nn(r.visit?.street),
          normalisePostcode(r.visit?.postcode) ?? null,
          nn(r.visit?.town),
          nn(r.kommun),
          nn(r.lan),
          nn(r.post?.street),
          normalisePostcode(r.post?.postcode) ?? null,
          nn(r.post?.town),
          geo?.address_id ?? null,
          geo?.lat ?? null,
          geo?.lon ?? null,
          geo?.cell ?? null,
          geo?.quality ?? "none",
          r.adBlock ? 1 : 0,
          r.sourceDate,
        ],
      });
      report.written++;
    }
    await runBatches(this.sql, statements);
    return report;
  }

  async upsertAddresses(records: AddressRecord[]): Promise<WriteReport> {
    const report = empty();
    const statements: Statement[] = [];
    for (const a of records) {
      if (!inSweden(a) || !a.street) {
        report.skippedInvalid++;
        continue;
      }
      const postcode = normalisePostcode(a.postcode) ?? null;
      const key = matchKey({ street: a.street, number: a.number ?? undefined, letter: a.letter ?? undefined, postcode: postcode ?? undefined });
      statements.push({
        sql: `INSERT INTO address (address_id, street, number, letter, postcode, town, kommun, match_key, lat, lon, cell, deso, source_date)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(address_id) DO UPDATE SET street = excluded.street, number = excluded.number, letter = excluded.letter,
  postcode = excluded.postcode, town = excluded.town, kommun = excluded.kommun, match_key = excluded.match_key, lat = excluded.lat,
  lon = excluded.lon, cell = excluded.cell, deso = COALESCE(excluded.deso, deso), source_date = excluded.source_date`,
        params: [a.addressId, a.street, nn(a.number), nn(a.letter), postcode, nn(a.town), nn(a.kommun), key, a.lat, a.lon, cellOf(a), nn(a.deso), a.sourceDate],
      });
      statements.push({ sql: "DELETE FROM address_fts WHERE address_id = ?", params: [a.addressId] });
      statements.push({ sql: "INSERT INTO address_fts (address_id, label) VALUES (?, ?)", params: [a.addressId, `${addressLabel(a)} ${postcode ?? ""}`.trim()] });
      report.written++;
    }
    await runBatches(this.sql, statements, 60);
    return report;
  }

  async upsertAreas(records: AreaRecord[]): Promise<WriteReport> {
    const statements = records.map<Statement>((a) => ({
      sql: `INSERT INTO area (deso, regso, kommun, name, lat, lon, min_lat, min_lon, max_lat, max_lon, geometry_key, geometry)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(deso) DO UPDATE SET regso = excluded.regso, kommun = excluded.kommun, name = excluded.name, lat = excluded.lat,
  lon = excluded.lon, min_lat = excluded.min_lat, min_lon = excluded.min_lon, max_lat = excluded.max_lat, max_lon = excluded.max_lon,
  geometry_key = excluded.geometry_key, geometry = excluded.geometry`,
      params: [a.deso, nn(a.regso), nn(a.kommun), nn(a.name), nn(a.lat), nn(a.lon), a.bbox?.[0] ?? null, a.bbox?.[1] ?? null, a.bbox?.[2] ?? null, a.bbox?.[3] ?? null, nn(a.geometryKey), a.geometry ? JSON.stringify(a.geometry) : null],
    }));
    await runBatches(this.sql, statements);
    return { ...empty(), written: records.length };
  }

  async upsertAreaStats(records: AreaStatRecord[]): Promise<WriteReport> {
    const statements = records.map<Statement>((s) => ({
      sql: `INSERT INTO area_stat (deso, table_id, variable, label, period, value) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(deso, table_id, variable, period) DO UPDATE SET label = excluded.label, value = excluded.value`,
      params: [s.deso, s.tableId, s.variable, nn(s.label), s.period, s.value],
    }));
    await runBatches(this.sql, statements);
    return { ...empty(), written: records.length };
  }

  async upsertAnnualReports(records: AnnualReportRecord[]): Promise<WriteReport> {
    const report = empty();
    const statements: Statement[] = [];
    for (const r of records) {
      if (classify({ id: r.orgnr }) !== "legal") {
        report.skippedNaturalPersons++;
        continue;
      }
      statements.push({
        sql: `INSERT INTO annual_report (document_id, orgnr, period_end, registered_at, format, object_key, sha256, size_bytes)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(document_id) DO UPDATE SET period_end = excluded.period_end, registered_at = excluded.registered_at, format = excluded.format,
  object_key = COALESCE(excluded.object_key, object_key), sha256 = COALESCE(excluded.sha256, sha256), size_bytes = COALESCE(excluded.size_bytes, size_bytes)`,
        params: [r.documentId, parseOrgnr(r.orgnr), nn(r.periodEnd), nn(r.registeredAt), nn(r.format), nn(r.objectKey), nn(r.sha256), nn(r.sizeBytes)],
      });
      report.written++;
    }
    await runBatches(this.sql, statements);
    return report;
  }

  async upsertSni(rows: { code: string; version: string; title: string }[]) {
    await runBatches(
      this.sql,
      rows.map((r) => ({ sql: "INSERT INTO sni (code, version, title) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET version = excluded.version, title = excluded.title", params: [r.code, r.version, r.title] })),
    );
  }

  async setMeta(key: string, value: string) {
    await this.sql.exec("INSERT INTO dataset_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [key, value, this.now().toISOString()]);
  }

  async getMeta(key: string): Promise<string | null> {
    return (await this.sql.first<{ value: string }>("SELECT value FROM dataset_meta WHERE key = ?", [key]))?.value ?? null;
  }

  async startRun(source: string): Promise<string> {
    const id = `${source}-${this.now().toISOString().replace(/[:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
    await this.sql.exec("INSERT INTO source_run (id, source, started_at, status) VALUES (?, ?, ?, 'running')", [id, source, this.now().toISOString()]);
    return id;
  }

  async finishRun(id: string, outcome: { status: "ok" | "failed"; rows?: number; skippedNaturalPersons?: number; snapshotId?: string; detail?: string }) {
    await this.sql.exec(
      "UPDATE source_run SET finished_at = ?, status = ?, rows = ?, skipped_natural_persons = ?, snapshot_id = ?, detail = ? WHERE id = ?",
      [this.now().toISOString(), outcome.status, outcome.rows ?? 0, outcome.skippedNaturalPersons ?? 0, outcome.snapshotId ?? null, outcome.detail ?? null, id],
    );
  }
}

export function mergeReports(a: WriteReport, b: WriteReport): WriteReport {
  return {
    written: a.written + b.written,
    skippedNaturalPersons: a.skippedNaturalPersons + b.skippedNaturalPersons,
    skippedInvalid: a.skippedInvalid + b.skippedInvalid,
  };
}
