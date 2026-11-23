/** SQLite-backed KV for single-process Linux installs and development. */
import type { KvPage, SqlStore } from "@opendata/ports";
import { BaseKvStore } from "./base";

export class SqliteKvStore extends BaseKvStore {
  readonly name = "sqlite";
  protected consistency = "strong" as const;
  private ready: Promise<void>;

  constructor(private readonly sql: SqlStore, private readonly table = "kv_store") {
    super();
    if (!/^[a-z_]+$/.test(table)) throw new TypeError("invalid table name");
    this.ready = sql.script(
      `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value BLOB NOT NULL, expires_at INTEGER);`,
    );
  }

  private now() {
    return Math.floor(Date.now() / 1000);
  }

  protected async rawGet(key: string) {
    await this.ready;
    const row = await this.sql.first<{ value: Uint8Array }>(
      `SELECT value FROM ${this.table} WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [key, this.now()],
    );
    return row ? new Uint8Array(row.value) : null;
  }
  protected async rawPut(key: string, value: Uint8Array, expiresAt?: number) {
    await this.ready;
    await this.sql.exec(
      `INSERT INTO ${this.table} (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      [key, value, expiresAt ?? null],
    );
  }
  protected async rawDelete(key: string) {
    await this.ready;
    await this.sql.exec(`DELETE FROM ${this.table} WHERE key = ?`, [key]);
  }
  protected async rawList(prefix: string, after: string | undefined, limit: number): Promise<KvPage> {
    await this.ready;
    const rows = await this.sql.query<{ key: string; expires_at: number | null }>(
      `SELECT key, expires_at FROM ${this.table} WHERE substr(key, 1, ?) = ? AND key > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?`,
      [prefix.length, prefix, after ?? "", this.now(), limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      keys: page.map((r) => ({ key: r.key, expiration: r.expires_at ?? undefined })),
      cursor: rows.length > limit ? page[page.length - 1]!.key : undefined,
    };
  }
  /** Drop expired rows; call from a timer. */
  async sweep(): Promise<number> {
    await this.ready;
    return (await this.sql.exec(`DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [this.now()])).changes;
  }
}
