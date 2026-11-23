/** Workers KV through a binding. Eventually consistent, last write wins. */
import type { KvPage } from "@opendata/ports";
import { BaseKvStore } from "./base";

export interface KvNamespaceLike {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export class CfKvStore extends BaseKvStore {
  readonly name = "cf-kv";
  protected consistency = "eventual" as const;
  constructor(private readonly kv: KvNamespaceLike) {
    super();
  }
  protected async rawGet(key: string) {
    const value = await this.kv.get(key, "arrayBuffer");
    return value ? new Uint8Array(value) : null;
  }
  protected async rawPut(key: string, value: Uint8Array, expiresAt?: number) {
    await this.kv.put(key, value, expiresAt === undefined ? undefined : { expiration: expiresAt });
  }
  protected async rawDelete(key: string) {
    await this.kv.delete(key);
  }
  /** Workers KV pages with opaque cursors; our cursor is passed through unchanged. */
  protected async rawList(prefix: string, cursor: string | undefined, limit: number): Promise<KvPage> {
    const result = await this.kv.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
    return {
      keys: result.keys.map((k) => ({ key: k.name, expiration: k.expiration })),
      cursor: result.list_complete ? undefined : result.cursor,
    };
  }
}
