import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { parseObjectKey } from "@opendata/ports";
import {
  checkManifest,
  contentDigest,
  fsckLayer,
  listSnapshots,
  loadManifest,
  manifestKey,
  publishSnapshot,
  readFile,
  stamp,
  validateRelativePath,
} from "../src";

const bytes = (n: number, seed = 1) => {
  // xorshift: no repeating 64 KiB blocks, so chunk counts are exact.
  let x = seed * 2654435761 || 1;
  return new Uint8Array(n).map(() => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return x & 0xff;
  });
};

describe("rbq layer snapshots", () => {
  it("formats stamps like chrono %Y%m%dT%H%M%S%.3fZ", () => {
    expect(stamp(new Date(Date.UTC(2026, 10, 14, 11, 26, 50, 973)))).toBe("20261114T112650.973Z");
  });

  it("publishes chunks before an immutable manifest and reassembles", async () => {
    const store = new MemoryObjectStore();
    const data = bytes(200_000, 3);
    const outcome = await publishSnapshot(store, {
      layer: "opendata",
      label: "local",
      files: [{ path: "opendata.sqlite", data }, { path: "kv/cache.jsonl", data: bytes(10) }],
      owner: { migration: { status: "current" } },
      now: new Date(Date.UTC(2026, 10, 23)),
    });
    expect(outcome.chunks).toBe(5);
    expect(outcome.newChunks).toBe(5);
    expect(outcome.id).toMatch(/^local\/20261123T000000\.000Z-[0-9a-f]{12}$/);
    const manifest = await loadManifest(store, "opendata", outcome.id);
    expect(Object.keys(manifest)).toEqual(["schema", "layer", "id", "label", "created_at", "run_id", "chunk_bytes", "digest", "files", "owner"]);
    expect(await readFile(store, manifest, "opendata.sqlite")).toEqual(data);
    expect((await fsckLayer(store, "opendata")).damaged).toEqual([]);
  });

  it("reuses identical chunks across snapshots", async () => {
    const store = new MemoryObjectStore();
    const data = bytes(65536 * 3);
    await publishSnapshot(store, { layer: "opendata", label: "a", files: [{ path: "f", data }], owner: {} });
    const changed = data.slice();
    changed[65536 * 2 + 5] = changed[65536 * 2 + 5]! ^ 0xff;
    const second = await publishSnapshot(store, { layer: "opendata", label: "a", files: [{ path: "f", data: changed }], owner: {}, now: new Date(Date.now() + 1000) });
    expect(second.newChunks).toBe(1);
    expect(second.reusedChunks).toBe(2);
    expect((await listSnapshots(store, "opendata", "a")).length).toBe(2);
  });

  it("detects damaged chunks", async () => {
    const store = new MemoryObjectStore();
    const outcome = await publishSnapshot(store, { layer: "opendata", label: "x", files: [{ path: "f", data: bytes(100) }], owner: {} });
    const manifest = await loadManifest(store, "opendata", outcome.id);
    const chunk = manifest.files[0]!.chunks[0]!;
    await store.put(parseObjectKey(`opendata/v1/chunks/sha256/${chunk.sha256.slice(0, 2)}/${chunk.sha256}`), bytes(100, 9));
    await expect(readFile(store, manifest, "f")).rejects.toMatchObject({ kind: "Corrupt" });
    expect((await fsckLayer(store, "opendata")).damaged).toHaveLength(1);
  });

  it("rejects hostile manifests", async () => {
    const base = { schema: "rbq.layer.snapshot.v1", layer: "opendata", id: "l/x", label: "l", created_at: "2026-01-01T00:00:00Z", run_id: null, chunk_bytes: 65536, owner: {} };
    const files = [{ path: "a", sha256: "0".repeat(64), bytes: 1, chunks: [{ sha256: "1".repeat(64), size: 1 }] }];
    const good = { ...base, files, digest: contentDigest(files) };
    expect(() => checkManifest(good, "opendata", "l/x")).not.toThrow();
    expect(() => checkManifest({ ...good, extra: 1 }, "opendata", "l/x")).toThrow(/unknown manifest field/);
    expect(() => checkManifest({ ...good, digest: "0".repeat(64) }, "opendata", "l/x")).toThrow(/digest/);
    expect(() => checkManifest(good, "opendata", "l/y")).toThrow(/id/);
    const traversal = [{ ...files[0]!, path: "../etc/passwd" }];
    expect(() => checkManifest({ ...base, files: traversal, digest: contentDigest(traversal) }, "opendata", "l/x")).toThrow();
    const sizes = [{ ...files[0]!, bytes: 2 }];
    expect(() => checkManifest({ ...base, files: sizes, digest: contentDigest(sizes) }, "opendata", "l/x")).toThrow(/add up/);
    for (const bad of ["", "/a", "a/../b", ".hidden", "a\\b", "a b"]) expect(() => validateRelativePath(bad), bad).toThrow();
    expect(() => manifestKey("unknown", "l/x")).toThrow(/unknown layer/);
  });

  it("refuses to overwrite a manifest", async () => {
    const store = new MemoryObjectStore();
    const now = new Date(Date.UTC(2026, 0, 1));
    await publishSnapshot(store, { layer: "messages", label: "x", files: [{ path: "f", data: bytes(1) }], owner: {}, now });
    await expect(publishSnapshot(store, { layer: "messages", label: "x", files: [{ path: "f", data: bytes(1) }], owner: {}, now })).rejects.toMatchObject({ kind: "AlreadyExists" });
  });
});
