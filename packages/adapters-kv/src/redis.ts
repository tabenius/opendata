/**
 * Valkey/Redis KV (Redis protocol via ioredis). Keys live under a namespace
 * prefix; listing uses SCAN, sorted per page, so it is eventually consistent
 * under concurrent writes, like Workers KV listing.
 */
import { Redis } from "ioredis";
import type { KvPage } from "@opendata/ports";
import { BaseKvStore } from "./base";

export class RedisKvStore extends BaseKvStore {
  readonly name = "redis";
  protected consistency = "strong" as const;

  constructor(
    private readonly client: Redis,
    private readonly namespace = "opendata:",
  ) {
    super();
  }

  static connect(url: string, namespace?: string): RedisKvStore {
    return new RedisKvStore(new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 }), namespace);
  }

  protected async rawGet(key: string) {
    const value = await this.client.getBuffer(this.namespace + key);
    return value ? new Uint8Array(value) : null;
  }
  protected async rawPut(key: string, value: Uint8Array, expiresAt?: number) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (expiresAt === undefined) await this.client.set(this.namespace + key, buffer);
    else await this.client.set(this.namespace + key, buffer, "EXAT", expiresAt);
  }
  protected async rawDelete(key: string) {
    await this.client.del(this.namespace + key);
  }
  protected async rawList(prefix: string, after: string | undefined, limit: number): Promise<KvPage> {
    // SCAN has no ordering; collect matching keys and page by key order.
    const pattern = this.namespace + prefix.replace(/[*?[\]\\]/g, "\\$&") + "*";
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 1000);
      cursor = next;
      for (const full of batch) {
        const key = full.slice(this.namespace.length);
        if (after === undefined || key > after) keys.push(key);
      }
    } while (cursor !== "0");
    keys.sort();
    const page = keys.slice(0, limit);
    const ttls = page.length ? await this.client.pipeline(page.map((k) => ["expiretime", this.namespace + k])).exec() : [];
    return {
      keys: page.map((key, i) => {
        const t = Number(ttls?.[i]?.[1] ?? -1);
        return { key, expiration: t > 0 ? t : undefined };
      }),
      cursor: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }
  async close() {
    await this.client.quit();
  }
}
