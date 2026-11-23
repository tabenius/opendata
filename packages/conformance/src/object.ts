import { describe, expect, it } from "vitest";
import { StorageError, listAll, parseObjectKey, type ObjectStore } from "@opendata/ports";

const k = parseObjectKey;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Every ObjectStore adapter must pass this suite. Each call gets a fresh, empty store. */
export function objectStoreConformance(name: string, make: () => Promise<ObjectStore>) {
  describe(`ObjectStore conformance: ${name}`, () => {
    it("reports capabilities with the rbq key limit", async () => {
      const store = await make();
      const caps = store.capabilities();
      expect(caps.rangeReads).toBe(true);
      expect(caps.rawPrefixListing).toBe(true);
      expect(caps.maxKeyBytes).toBeGreaterThan(0);
    });

    it("puts, gets, heads and replaces", async () => {
      const store = await make();
      const meta = await store.put(k("a/b.txt"), "hello");
      expect(meta.size).toBe(5);
      expect(text(await store.get(k("a/b.txt")))).toBe("hello");
      expect((await store.head(k("a/b.txt"))).size).toBe(5);
      await store.put(k("a/b.txt"), "replaced");
      expect(text(await store.get(k("a/b.txt")))).toBe("replaced");
    });

    it("creates only when absent and never overwrites", async () => {
      const store = await make();
      const first = await store.putIfAbsent(k("immutable/x"), "one");
      expect(first.created).toBe(true);
      const second = await store.putIfAbsent(k("immutable/x"), "two-two");
      expect(second.created).toBe(false);
      expect(second.meta.size).toBe(3);
      expect(text(await store.get(k("immutable/x")))).toBe("one");
    });

    it("has exactly one winner under concurrent create-if-absent", async () => {
      const store = await make();
      if (!store.capabilities().atomicCreateIfAbsent) return;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.putIfAbsent(k("race/key"), `writer-${i}`)),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const winner = results.findIndex((r) => r.created);
      expect(text(await store.get(k("race/key")))).toBe(`writer-${winner}`);
    });

    it("reads ranges as half-open intervals", async () => {
      const store = await make();
      await store.put(k("r"), "0123456789");
      expect(text(await store.getRange(k("r"), { start: 2, end: 5 }))).toBe("234");
      expect(text(await store.getRange(k("r"), { start: 8, end: 100 }))).toBe("89");
      await expect(store.getRange(k("r"), { start: 5, end: 5 })).rejects.toMatchObject({ kind: "InvalidKey" });
    });

    it("streams objects", async () => {
      const store = await make();
      await store.put(k("s"), "streamed");
      const stream = await store.getStream(k("s"));
      const reader = stream.getReader();
      const parts: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }
      expect(parts.map(text).join("")).toBe("streamed");
    });

    it("maps a missing object to NotFound", async () => {
      const store = await make();
      await expect(store.get(k("missing"))).rejects.toBeInstanceOf(StorageError);
      await expect(store.get(k("missing"))).rejects.toMatchObject({ kind: "NotFound" });
      await expect(store.head(k("missing/deeper"))).rejects.toMatchObject({ kind: "NotFound" });
    });

    it("lists by raw string prefix, sorted, with after-paging", async () => {
      const store = await make();
      for (const key of ["notes/b", "notes/a", "notes-x", "note", "notes/c/d", "other/z"]) await store.put(k(key), key);
      const all = await store.listPrefix("notes");
      expect(all.objects.map((o) => o.key)).toEqual(["notes-x", "notes/a", "notes/b", "notes/c/d"]);
      const slash = await store.listPrefix("notes/");
      expect(slash.objects.map((o) => o.key)).toEqual(["notes/a", "notes/b", "notes/c/d"]);
      const mid = await store.listPrefix("notes/c");
      expect(mid.objects.map((o) => o.key)).toEqual(["notes/c/d"]);
      const page1 = await store.listPrefix("notes/", { limit: 2 });
      expect(page1.objects.map((o) => o.key)).toEqual(["notes/a", "notes/b"]);
      expect(page1.nextAfter).toBe("notes/b");
      const page2 = await store.listPrefix("notes/", { limit: 2, after: page1.nextAfter });
      expect(page2.objects.map((o) => o.key)).toEqual(["notes/c/d"]);
      expect(page2.nextAfter).toBeUndefined();
      const everything: string[] = [];
      for await (const o of listAll(store, "", 2)) everything.push(o.key);
      expect(everything).toEqual(["note", "notes-x", "notes/a", "notes/b", "notes/c/d", "other/z"]);
    });

    it("refuses invalid prefixes", async () => {
      const store = await make();
      await expect(store.listPrefix("/a")).rejects.toMatchObject({ kind: "InvalidKey" });
      await expect(store.listPrefix("a//")).rejects.toMatchObject({ kind: "InvalidKey" });
      await expect(store.listPrefix("../")).rejects.toMatchObject({ kind: "InvalidKey" });
    });

    it("deletes (administration only)", async () => {
      const store = await make();
      await store.put(k("gone"), "x");
      await store.delete(k("gone"));
      await expect(store.head(k("gone"))).rejects.toMatchObject({ kind: "NotFound" });
      await store.delete(k("gone"));
    });

    it("stores binary bytes exactly", async () => {
      const store = await make();
      const bytes = new Uint8Array(70000).map((_, i) => (i * 31) & 0xff);
      await store.put(k("bin/blob"), bytes);
      expect(await store.get(k("bin/blob"))).toEqual(bytes);
    });
  });
}
