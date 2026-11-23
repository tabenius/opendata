import type { Bytes } from "./bytes";

export interface KvCapabilities {
  consistency: "eventual" | "strong";
  /** Workers KV refuses TTLs under 60 s; adapters round up to this. */
  minTtlSeconds: number;
  maxValueBytes: number;
  maxKeyBytes: number;
}

export interface KvEntry {
  key: string;
  expiration?: number;
}

export interface KvPage {
  keys: KvEntry[];
  cursor?: string;
}

/**
 * The Workers KV lowest common denominator: last write wins, eventual
 * consistency, no compare-and-swap. KV is never the system of record.
 * Keys use the rbq object key grammar so namespaces export as objects.
 */
export interface KvStore {
  readonly name: string;
  capabilities(): KvCapabilities;
  get(key: string): Promise<Uint8Array | null>;
  getText(key: string): Promise<string | null>;
  getJson<T>(key: string): Promise<T | null>;
  put(key: string, value: Bytes, options?: { ttlSeconds?: number }): Promise<void>;
  putJson(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<KvPage>;
  close?(): Promise<void>;
}
