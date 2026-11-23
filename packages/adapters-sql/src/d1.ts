/**
 * Cloudflare D1 through a Worker binding. D1 is SQLite; `batch` is atomic.
 * D1 limits bound parameters per statement to 100, so callers that build
 * IN-lists must chunk (see `capabilities().maxBoundParams`).
 */
import { StorageError, type ExecResult, type SqlCapabilities, type SqlStore, type SqlValue, type Statement } from "@opendata/ports";

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  all<T = unknown>(): Promise<{ results: T[]; meta?: { changes?: number; last_row_id?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<{ meta: { changes?: number; last_row_id?: number } }[]>;
  exec(sql: string): Promise<unknown>;
}

function values(params: SqlValue[] = []): unknown[] {
  return params.map((p) => (typeof p === "bigint" ? Number(p) : p instanceof Uint8Array ? [...p] : p));
}

function wrap(error: unknown): never {
  const message = (error as Error)?.message ?? String(error);
  if (/UNIQUE constraint|PRIMARY KEY/.test(message)) throw new StorageError("AlreadyExists", message);
  if (/overloaded|timeout|reset/i.test(message)) throw StorageError.unavailable(message, error);
  throw StorageError.backend(message, error);
}

export class D1SqlStore implements SqlStore {
  readonly name = "d1";
  constructor(private readonly db: D1DatabaseLike) {}

  capabilities(): SqlCapabilities {
    return { dialect: "sqlite", maxBoundParams: 100, batchAtomic: true, fileSnapshot: false };
  }

  private prepare(sql: string, params?: SqlValue[]) {
    const statement = this.db.prepare(sql);
    return params && params.length ? statement.bind(...values(params)) : statement;
  }

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]> {
    try {
      return (await this.prepare(sql, params).all<T>()).results;
    } catch (error) {
      wrap(error);
    }
  }

  async first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null> {
    try {
      return await this.prepare(sql, params).first<T>();
    } catch (error) {
      wrap(error);
    }
  }

  async exec(sql: string, params?: SqlValue[]): Promise<ExecResult> {
    try {
      const { meta } = await this.prepare(sql, params).run();
      return { changes: meta.changes ?? 0, lastRowId: meta.last_row_id };
    } catch (error) {
      wrap(error);
    }
  }

  async batch(statements: Statement[]): Promise<ExecResult[]> {
    if (statements.length === 0) return [];
    try {
      const results = await this.db.batch(statements.map((s) => this.prepare(s.sql, s.params)));
      return results.map((r) => ({ changes: r.meta.changes ?? 0, lastRowId: r.meta.last_row_id }));
    } catch (error) {
      wrap(error);
    }
  }

  async script(sql: string): Promise<void> {
    // D1 exec() wants one statement per line; split on statement ends instead.
    const statements = splitStatements(sql);
    try {
      await this.db.batch(statements.map((s) => this.db.prepare(s)));
    } catch (error) {
      wrap(error);
    }
  }
}

/**
 * Split a SQL script into statements on `;` outside quotes. Migrations in this
 * project contain no triggers, so there are no BEGIN...END bodies to track.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  const text = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  for (const ch of text) {
    current += ch;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ";") {
      if (current.trim() !== ";") out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
