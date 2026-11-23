/**
 * Dataset snapshots as rbq layer `opendata`:
 *
 *   tables/<table>.ndjson   one JSON object per row, DB column names
 *   meta.json               { schema: "opendata.snapshot.v1", migrations, rows }
 *   opendata.sqlite         optional, whole database (Rust ingest), for rbq peers
 *
 * One import path for every runtime: rows are upserted into the live tables
 * through SqlStore with `snapshot = <id>`, resumably (the Worker cron imports
 * a bounded number of rows per tick), then rows from older snapshots are
 * removed and `active_snapshot` flips. Snapshots may come from peers, so the
 * table/column allow-list and the privacy guard are applied again here.
 */
import { StorageError, isStorageError, parseObjectKey, type ObjectStore, type SqlStore, type SqlValue, type Statement } from "@opendata/ports";
import { addressLabel } from "./address";
import { classify } from "./privacy";
import { migrations } from "@opendata/schema";

export const SNAPSHOT_META_SCHEMA = "opendata.snapshot.v1";
const LEASE_MS = 10 * 60 * 1000;

export interface TableSpec {
  name: string;
  pk: string[];
  columns: string[];
  /** Column holding an identity that must classify as a legal entity. */
  identity?: string;
}

/** Import order matters: addresses before workplaces is irrelevant here (coordinates are in the rows). */
export const TABLES: TableSpec[] = [
  { name: "sni", pk: ["code"], columns: ["code", "version", "title"] },
  { name: "area", pk: ["deso"], columns: ["deso", "regso", "kommun", "name", "lat", "lon", "min_lat", "min_lon", "max_lat", "max_lon", "geometry_key", "geometry"] },
  { name: "area_stat", pk: ["deso", "table_id", "variable", "period"], columns: ["deso", "table_id", "variable", "label", "period", "value"] },
  { name: "address", pk: ["address_id"], columns: ["address_id", "street", "number", "letter", "postcode", "town", "kommun", "match_key", "lat", "lon", "cell", "deso", "source_date"] },
  {
    name: "organisation",
    pk: ["orgnr"],
    identity: "orgnr",
    columns: ["orgnr", "name", "legal_form", "legal_form_code", "status", "registered_at", "deregistered_at", "deregistration_reason", "business_description", "post_street", "post_postcode", "post_town", "sni_primary", "sni_codes", "ad_block", "sources", "source_date", "updated_at"],
  },
  {
    name: "workplace",
    pk: ["cfar"],
    identity: "orgnr",
    columns: ["cfar", "orgnr", "name", "sni", "sni_division", "size_class", "status", "visit_street", "visit_postcode", "visit_town", "kommun", "lan", "post_street", "post_postcode", "post_town", "address_id", "lat", "lon", "cell", "geocode_quality", "ad_block", "source_date"],
  },
  { name: "annual_report", pk: ["document_id"], identity: "orgnr", columns: ["document_id", "orgnr", "period_end", "registered_at", "format", "object_key", "sha256", "size_bytes"] },
];

export interface SnapshotMeta {
  schema: string;
  migrations: string[];
  rows: Record<string, number>;
  created_by: string;
}

const encoder = new TextEncoder();

/** Export the current database as snapshot files (fine for TS-scale data; Rust ingest does national scale). */
export async function exportTables(sql: SqlStore, createdBy = "opendata-ts"): Promise<{ path: string; data: Uint8Array }[]> {
  const files: { path: string; data: Uint8Array }[] = [];
  const rows: Record<string, number> = {};
  for (const table of TABLES) {
    const result = await sql.query<Record<string, unknown>>(`SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY ${table.pk.join(", ")}`);
    rows[table.name] = result.length;
    files.push({ path: `tables/${table.name}.ndjson`, data: encoder.encode(result.map((r) => JSON.stringify(r)).join("\n") + (result.length ? "\n" : "")) });
  }
  const meta: SnapshotMeta = { schema: SNAPSHOT_META_SCHEMA, migrations: migrations.map((m) => m.id), rows, created_by: createdBy };
  files.push({ path: "meta.json", data: encoder.encode(JSON.stringify(meta, null, 2)) });
  return files;
}

export function snapshotOwner(meta: SnapshotMeta) {
  return { migration: { status: "current" }, schema: SNAPSHOT_META_SCHEMA, migrations: meta.migrations, rows: meta.rows };
}

// -- import -----------------------------------------------------------------

interface ManifestLike {
  id: string;
  layer: string;
  files: { path: string; sha256: string; bytes: number; chunks: { sha256: string; size: number }[] }[];
}

export interface ImportState {
  snapshotId: string;
  table: number;
  /** Rows seen in the current table (imported + skipped), checked against meta.json. */
  tableRows?: number;
  chunk: number;
  /** Bytes after the last newline of the previous chunk, base64. */
  carry: string;
  rows: number;
  skipped: number;
  done: boolean;
}

export interface ImportOptions {
  /** Stop after roughly this many rows; call again to continue. */
  rowBudget?: number;
  /** Verify a chunk digest (injected so core stays hash-library free). */
  sha256Hex: (data: Uint8Array) => string;
  now?: () => Date;
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function value(v: unknown, column: string): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw StorageError.corrupt(`unsupported value in column ${column}`);
}

function upsertStatements(table: TableSpec, row: Record<string, unknown>, snapshotId: string): Statement[] {
  for (const key of Object.keys(row)) if (!table.columns.includes(key)) throw StorageError.corrupt(`unknown column ${table.name}.${key}`);
  const columns = [...table.columns, "snapshot"];
  const params = [...table.columns.map((c) => value(row[c], c)), snapshotId];
  const updates = columns.filter((c) => !table.pk.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
  const statements: Statement[] = [
    {
      sql: `INSERT INTO ${table.name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT(${table.pk.join(", ")}) DO UPDATE SET ${updates}`,
      params,
    },
  ];
  if (table.name === "organisation") {
    statements.push({ sql: "DELETE FROM organisation_fts WHERE orgnr = ?", params: [row.orgnr as string] });
    statements.push({ sql: "INSERT INTO organisation_fts (orgnr, name) VALUES (?, ?)", params: [row.orgnr as string, row.name as string] });
  }
  if (table.name === "address") {
    const label = `${addressLabel({ street: String(row.street), number: row.number as string | null, letter: row.letter as string | null, postcode: row.postcode as string | null, town: row.town as string | null })} ${row.postcode ?? ""}`.trim();
    statements.push({ sql: "DELETE FROM address_fts WHERE address_id = ?", params: [row.address_id as string] });
    statements.push({ sql: "INSERT INTO address_fts (address_id, label) VALUES (?, ?)", params: [row.address_id as string, label] });
  }
  return statements;
}

async function getMeta(sql: SqlStore, key: string) {
  return (await sql.first<{ value: string }>("SELECT value FROM dataset_meta WHERE key = ?", [key]))?.value ?? null;
}

async function setMeta(sql: SqlStore, key: string, value: string, now: Date) {
  await sql.exec("INSERT INTO dataset_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [key, value, now.toISOString()]);
}

export async function activeSnapshot(sql: SqlStore): Promise<string | null> {
  return getMeta(sql, "active_snapshot");
}

/**
 * Import (or continue importing) a snapshot. Returns the state; `done` means
 * the snapshot is active. Safe to call repeatedly and from overlapping crons
 * (a lease in dataset_meta serialises them).
 */
export async function importSnapshot(sql: SqlStore, objects: ObjectStore, manifest: ManifestLike, options: ImportOptions): Promise<ImportState> {
  const now = options.now ?? (() => new Date());
  if (manifest.layer !== "opendata") throw StorageError.invalidKey("not an opendata snapshot");
  if ((await activeSnapshot(sql)) === manifest.id) return { snapshotId: manifest.id, table: TABLES.length, chunk: 0, carry: "", rows: 0, skipped: 0, done: true };

  // Atomic lease: one conditional write takes it only if absent or expired;
  // `value` is "<expiry ms>|<owner>", and only the owner releases it.
  const owner = crypto.randomUUID();
  const leaseValue = `${now().getTime() + LEASE_MS}|${owner}`;
  const taken = await sql.exec(
    `INSERT INTO dataset_meta (key, value, updated_at) VALUES ('import_lease', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE CAST(substr(dataset_meta.value, 1, instr(dataset_meta.value, '|') - 1) AS INTEGER) <= ?`,
    [leaseValue, now().toISOString(), now().getTime()],
  );
  if (taken.changes !== 1) throw StorageError.unavailable("another import holds the lease");

  try {
    const metaFile = manifest.files.find((f) => f.path === "meta.json");
    if (!metaFile) throw StorageError.corrupt("snapshot has no meta.json");
    const metaBytes = await readWhole(objects, manifest, metaFile, options.sha256Hex);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as SnapshotMeta;
    if (meta.schema !== SNAPSHOT_META_SCHEMA) throw StorageError.corrupt("unsupported snapshot schema");
    const known = new Set(migrations.map((m) => m.id));
    const unknown = meta.migrations.filter((m) => !known.has(m));
    if (unknown.length) throw new StorageError("Unsupported", `snapshot needs migrations this build lacks: ${unknown.join(", ")}`);

    const saved = await getMeta(sql, "import_state");
    let state: ImportState = saved ? (JSON.parse(saved) as ImportState) : { snapshotId: manifest.id, table: 0, chunk: 0, carry: "", rows: 0, skipped: 0, done: false };
    if (state.snapshotId !== manifest.id) state = { snapshotId: manifest.id, table: 0, chunk: 0, carry: "", rows: 0, skipped: 0, done: false };
    const budget = options.rowBudget ?? Infinity;
    let processed = 0;
    const prefix = `${manifest.layer}/v1`;

    while (state.table < TABLES.length) {
      const table = TABLES[state.table]!;
      const file = manifest.files.find((f) => f.path === `tables/${table.name}.ndjson`);
      if (!file) {
        state = { ...state, table: state.table + 1, chunk: 0, carry: "" };
        continue;
      }
      while (state.chunk < file.chunks.length) {
        if (processed >= budget) {
          await setMeta(sql, "import_state", JSON.stringify(state), now());
          return state;
        }
        const chunk = file.chunks[state.chunk]!;
        const data = await objects.get(parseObjectKey(`${prefix}/chunks/sha256/${chunk.sha256.slice(0, 2)}/${chunk.sha256}`));
        if (data.length !== chunk.size || options.sha256Hex(data) !== chunk.sha256) throw StorageError.corrupt(`${file.path}: chunk ${state.chunk} is damaged`);
        let buffer = concat(fromB64(state.carry), data);
        const last = buffer.lastIndexOf(0x0a);
        const isLastChunk = state.chunk === file.chunks.length - 1;
        const complete = isLastChunk ? buffer : buffer.subarray(0, last + 1);
        const carry = isLastChunk ? new Uint8Array() : buffer.subarray(last + 1);
        if (carry.length > 1024 * 1024) throw StorageError.corrupt("row longer than 1 MiB");
        const statements: Statement[] = [];
        for (const line of new TextDecoder("utf-8", { fatal: true }).decode(complete).split("\n")) {
          if (!line.trim()) continue;
          const row = JSON.parse(line) as Record<string, unknown>;
          state.tableRows = (state.tableRows ?? 0) + 1;
          if (table.identity && classify({ id: String(row[table.identity] ?? "") }) !== "legal") {
            state.skipped++;
            continue;
          }
          statements.push(...upsertStatements(table, row, manifest.id));
          state.rows++;
          processed++;
        }
        for (let i = 0; i < statements.length; i += 60) await sql.batch(statements.slice(i, i + 60));
        buffer = new Uint8Array();
        state = { ...state, chunk: state.chunk + 1, carry: toB64(carry) };
        await setMeta(sql, "import_state", JSON.stringify(state), now());
      }
      const expected = meta.rows[table.name];
      if (expected !== undefined && (state.tableRows ?? 0) !== expected)
        throw StorageError.corrupt(`tables/${table.name}.ndjson has ${state.tableRows ?? 0} rows, meta.json says ${expected}`);
      state = { ...state, table: state.table + 1, tableRows: 0, chunk: 0, carry: "" };
      await setMeta(sql, "import_state", JSON.stringify(state), now());
    }

    // Everything is in: drop rows only older snapshots had, then flip.
    const cleanup: Statement[] = TABLES.map((t) => ({ sql: `DELETE FROM ${t.name} WHERE snapshot IS NOT ?`, params: [manifest.id] }));
    cleanup.push({ sql: "DELETE FROM organisation_fts WHERE orgnr NOT IN (SELECT orgnr FROM organisation)" });
    cleanup.push({ sql: "DELETE FROM address_fts WHERE address_id NOT IN (SELECT address_id FROM address)" });
    cleanup.push({ sql: "INSERT INTO dataset_meta (key, value, updated_at) VALUES ('active_snapshot', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", params: [manifest.id, now().toISOString()] });
    cleanup.push({ sql: "DELETE FROM dataset_meta WHERE key IN ('import_state')" });
    await sql.batch(cleanup);
    return { ...state, done: true };
  } finally {
    await sql.exec("DELETE FROM dataset_meta WHERE key = 'import_lease' AND value = ?", [leaseValue]);
  }
}

async function readWhole(objects: ObjectStore, manifest: ManifestLike, file: ManifestLike["files"][number], sha256Hex: (d: Uint8Array) => string) {
  let out = new Uint8Array();
  for (const chunk of file.chunks) {
    const data = await objects.get(parseObjectKey(`${manifest.layer}/v1/chunks/sha256/${chunk.sha256.slice(0, 2)}/${chunk.sha256}`));
    if (sha256Hex(data) !== chunk.sha256) throw StorageError.corrupt(`${file.path} is damaged`);
    out = concat(out, data);
  }
  if (sha256Hex(out) !== file.sha256) throw StorageError.corrupt(`${file.path} digest mismatch`);
  return out;
}

export { isStorageError };
