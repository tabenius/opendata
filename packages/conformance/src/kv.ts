import { describe, expect, it } from "vitest";
import type { KvStore } from "@opendata/ports";

export function kvStoreConformance(name: string, make: () => Promise<KvStore>, options: { eventual?: boolean } = {}) {
  describe(`KvStore conformance: ${name}`, () => {
    it("puts, gets text, bytes and JSON, deletes", async () => {
      const kv = await make();
      await kv.put("cache/a", "alpha");
      expect(await kv.getText("cache/a")).toBe("alpha");
      await kv.put("cache/bin", new Uint8Array([0, 255, 1]));
      expect(await kv.get("cache/bin")).toEqual(new Uint8Array([0, 255, 1]));
      await kv.putJson("cache/j", { x: [1, 2], s: "å" });
      expect(await kv.getJson("cache/j")).toEqual({ x: [1, 2], s: "å" });
      await kv.delete("cache/a");
      expect(await kv.get("cache/a")).toBeNull();
      expect(await kv.get("never/set")).toBeNull();
    });

    it("uses the rbq key grammar", async () => {
      const kv = await make();
      await expect(kv.put("../x", "v")).rejects.toThrow();
      await expect(kv.put("a b", "v")).rejects.toThrow();
      await expect(kv.put("", "v")).rejects.toThrow();
    });

    it("accepts TTLs and reports the Workers KV floor", async () => {
      const kv = await make();
      expect(kv.capabilities().minTtlSeconds).toBe(60);
      await kv.put("ttl/x", "v", { ttlSeconds: 1 });
      expect(await kv.getText("ttl/x")).toBe("v");
      await expect(kv.put("ttl/y", "v", { ttlSeconds: 0 })).rejects.toThrow();
    });

    it("lists by prefix with paging", async () => {
      const kv = await make();
      for (const key of ["l/c", "l/a", "l/b", "m/a"]) await kv.put(key, key);
      if (options.eventual) await new Promise((r) => setTimeout(r, 50));
      const first = await kv.list("l/", { limit: 2 });
      expect(first.keys.map((k) => k.key)).toEqual(["l/a", "l/b"]);
      expect(first.cursor).toBeDefined();
      const second = await kv.list("l/", { limit: 2, cursor: first.cursor });
      expect(second.keys.map((k) => k.key)).toEqual(["l/c"]);
      expect(second.cursor).toBeUndefined();
    });
  });
}
