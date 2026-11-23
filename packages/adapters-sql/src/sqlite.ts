/**
 * SQLite through Node's built-in `node:sqlite` (no native addon to build).
 * WAL, foreign keys, busy timeout. `batch` is one IMMEDIATE transaction.
 * `exportFile` is `VACUUM INTO`: a consistent, page-aligned copy, which is
 * what rbq's chunking reuses best.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageError, type ExecResult, type SqlCapabilities, type SqlStore, type SqlValue, type Statement } from "@opendata/ports";

function bind(params: SqlValue[] = []): SQLInputValue[] {
  return params.map((p) => (typeof p === "bigint" ? p : p)) as SQLInputValue[];
}

function normalizeRow<T>(row: unknown): T {
  // node:sqlite returns null-prototype objects; give callers plain ones.
  return { ...(row as object) } as T;
}

export interface SqliteOptions {
  readOnly?: boolean;
}

export class SqliteSqlStore implements SqlStore {
  readonly name = "sqlite";
  private readonly db: DatabaseSync;

  constructor(
    readonly file: string = ":memory:",
    options: SqliteOptions = {},
  ) {
    this.db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (!options.readOnly) {
      if (file !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  capabilities(): SqlCapabilities {
    return { dialect: "sqlite", maxBoundParams: 32766, batchAtomic: true, fileSnapshot: true };
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const message = (error as Error).message ?? String(error);
      if (/UNIQUE constraint|PRIMARY KEY/.test(message)) throw new StorageError("AlreadyExists", message);
      if (/readonly|read-only/i.test(message)) throw new StorageError("PermissionDenied", message);
      if (/busy|locked/i.test(message)) throw StorageError.unavailable(message, error);
      throw StorageError.backend(message, error);
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]> {
    return this.wrap(() => this.db.prepare(sql).all(...bind(params)).map((r) => normalizeRow<T>(r)));
  }

  async first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null> {
    return this.wrap(() => {
      const row = this.db.prepare(sql).get(...bind(params));
      return row === undefined ? null : normalizeRow<T>(row);
    });
  }

  private run(sql: string, params?: SqlValue[]): ExecResult {
    const result = this.db.prepare(sql).run(...bind(params));
    return { changes: Number(result.changes), lastRowId: Number(result.lastInsertRowid) };
  }

  async exec(sql: string, params?: SqlValue[]): Promise<ExecResult> {
    return this.wrap(() => this.run(sql, params));
  }

  async batch(statements: Statement[]): Promise<ExecResult[]> {
    return this.wrap(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((s) => this.run(s.sql, s.params));
        this.db.exec("COMMIT");
        return results;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async script(sql: string): Promise<void> {
    this.wrap(() => this.db.exec(sql));
  }

  async exportFile(): Promise<Uint8Array> {
    const dir = await mkdtemp(path.join(tmpdir(), "od-export-"));
    const target = path.join(dir, "export.sqlite");
    try {
      this.wrap(() => this.db.prepare("VACUUM INTO ?").run(target));
      const check = new DatabaseSync(target, { readOnly: true });
      try {
        const row = check.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        if (row.integrity_check !== "ok") throw StorageError.corrupt(`exported database: ${row.integrity_check}`);
      } finally {
        check.close();
      }
      return new Uint8Array(await readFile(target));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
