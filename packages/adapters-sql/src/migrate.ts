import type { Migration, MigrationReport, SqlStore } from "@opendata/ports";
import { checksum as digest } from "./hash";

/**
 * Apply numbered migrations once, recording id + checksum. A changed checksum
 * for an applied migration is refused: migrations are append-only.
 */
export async function migrate(sql: SqlStore, migrations: Migration[]): Promise<MigrationReport> {
  await sql.script(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);",
  );
  const done = new Map(
    (await sql.query<{ id: string; checksum: string }>("SELECT id, checksum FROM schema_migrations")).map((r) => [r.id, r.checksum]),
  );
  const applied: string[] = [];
  const sorted = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  for (const migration of sorted) {
    const checksum = digest(migration.sql);
    const existing = done.get(migration.id);
    if (existing) {
      if (existing !== checksum) throw new Error(`migration ${migration.id} changed after it was applied`);
      continue;
    }
    await sql.script(migration.sql);
    await sql.exec("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)", [migration.id, checksum, new Date().toISOString()]);
    applied.push(migration.id);
  }
  return { applied, current: sorted.map((m) => m.id) };
}
