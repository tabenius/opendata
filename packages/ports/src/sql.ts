export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Statement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlCapabilities {
  dialect: "sqlite";
  /** D1 caps bound parameters per statement (100); SQLite allows far more. */
  maxBoundParams: number;
  /** `batch` runs as one transaction. */
  batchAtomic: boolean;
  /** `snapshot()` can export a consistent database file. */
  fileSnapshot: boolean;
}

export interface ExecResult {
  changes: number;
  lastRowId?: number;
}

export interface Migration {
  /** Monotonic, e.g. "0001_init". */
  id: string;
  sql: string;
}

export interface MigrationReport {
  applied: string[];
  current: string[];
}

/**
 * SQL in the SQLite dialect, which is what D1 is. No interactive transactions
 * (D1 has none): use `batch` for atomic groups so both backends behave alike.
 */
export interface SqlStore {
  readonly name: string;
  capabilities(): SqlCapabilities;
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  exec(sql: string, params?: SqlValue[]): Promise<ExecResult>;
  batch(statements: Statement[]): Promise<ExecResult[]>;
  /** Execute a multi-statement script (migrations). Not parameterised. */
  script(sql: string): Promise<void>;
  /** Consistent database file (SQLite `VACUUM INTO`). Unsupported on D1. */
  exportFile?(): Promise<Uint8Array>;
  close?(): Promise<void>;
}
