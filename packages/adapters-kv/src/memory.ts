import type { KvPage } from "@opendata/ports";
import { BaseKvStore } from "./base";

export class MemoryKvStore extends BaseKvStore {
  readonly name = "memory";
  protected consistency = "strong" as const;
  private readonly data = new Map<string, { value: Uint8Array; expiresAt?: number }>();

  private live(key: string) {
    const entry = this.data.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now() / 1000) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  protected async rawGet(key: string) {
    return this.live(key)?.value.slice() ?? null;
  }
  protected async rawPut(key: string, value: Uint8Array, expiresAt?: number) {
    this.data.set(key, { value: value.slice(), expiresAt });
  }
  protected async rawDelete(key: string) {
    this.data.delete(key);
  }
  protected async rawList(prefix: string, after: string | undefined, limit: number): Promise<KvPage> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix) && (after === undefined || k > after) && this.live(k)).sort();
    const page = keys.slice(0, limit);
    return {
      keys: page.map((key) => ({ key, expiration: this.data.get(key)?.expiresAt })),
      cursor: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }
}
