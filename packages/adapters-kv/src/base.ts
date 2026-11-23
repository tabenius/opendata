import { MAX_KEY_BYTES, parseObjectKey, toBytes, utf8, validatePrefix, type Bytes, type KvCapabilities, type KvPage, type KvStore } from "@opendata/ports";

export const MIN_TTL_SECONDS = 60;
export const MAX_VALUE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_KV_LIST = 1000;

/** Shared key/TTL/JSON handling so every adapter behaves like Workers KV. */
export abstract class BaseKvStore implements KvStore {
  abstract readonly name: string;
  protected abstract consistency: "eventual" | "strong";
  protected abstract rawGet(key: string): Promise<Uint8Array | null>;
  protected abstract rawPut(key: string, value: Uint8Array, expiresAt?: number): Promise<void>;
  protected abstract rawDelete(key: string): Promise<void>;
  protected abstract rawList(prefix: string, after: string | undefined, limit: number): Promise<KvPage>;

  capabilities(): KvCapabilities {
    return { consistency: this.consistency, minTtlSeconds: MIN_TTL_SECONDS, maxValueBytes: MAX_VALUE_BYTES, maxKeyBytes: Math.min(512, MAX_KEY_BYTES) };
  }

  protected key(key: string): string {
    if (key.length > 512) throw new RangeError("KV keys are limited to 512 bytes (Workers KV)");
    return parseObjectKey(key);
  }

  /** Workers KV refuses TTLs under 60 s; round up so every backend agrees. */
  protected expiry(ttlSeconds?: number): number | undefined {
    if (ttlSeconds === undefined) return undefined;
    if (!(ttlSeconds > 0)) throw new RangeError("ttlSeconds must be positive");
    return Math.floor(Date.now() / 1000) + Math.max(Math.ceil(ttlSeconds), MIN_TTL_SECONDS);
  }

  async get(key: string) {
    return this.rawGet(this.key(key));
  }

  async getText(key: string) {
    const value = await this.get(key);
    return value === null ? null : utf8(value);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const text = await this.getText(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  async put(key: string, value: Bytes, options?: { ttlSeconds?: number }) {
    const bytes = toBytes(value);
    if (bytes.length > MAX_VALUE_BYTES) throw new RangeError("value exceeds 25 MiB");
    await this.rawPut(this.key(key), bytes, this.expiry(options?.ttlSeconds));
  }

  async putJson(key: string, value: unknown, options?: { ttlSeconds?: number }) {
    await this.put(key, JSON.stringify(value), options);
  }

  async delete(key: string) {
    await this.rawDelete(this.key(key));
  }

  async list(prefix: string, options: { cursor?: string; limit?: number } = {}): Promise<KvPage> {
    validatePrefix(prefix);
    const limit = Math.min(options.limit || DEFAULT_KV_LIST, DEFAULT_KV_LIST);
    return this.rawList(prefix, options.cursor, limit);
  }
}
