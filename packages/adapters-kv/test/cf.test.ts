import { afterAll } from "vitest";
import { kvStoreConformance } from "@opendata/conformance";
import { disposeMiniflare, miniflare } from "@opendata/conformance/miniflare";
import { CfKvStore, type KvNamespaceLike } from "../src/cf";

let n = 0;
kvStoreConformance(
  "workers kv (miniflare)",
  async () => {
    const kv = (await miniflare().getKVNamespace("KV")) as unknown as KvNamespaceLike;
    const root = `t${++n}/`;
    // Scope each test under its own prefix of the shared namespace.
    const scoped: KvNamespaceLike = {
      get: (k, t) => kv.get(root + k, t),
      put: (k, v, o) => kv.put(root + k, v, o),
      delete: (k) => kv.delete(root + k),
      list: async (o) => {
        const r = await kv.list({ ...o, prefix: root + (o?.prefix ?? "") });
        return { ...r, keys: r.keys.map((x) => ({ ...x, name: x.name.slice(root.length) })) };
      },
    };
    return new CfKvStore(scoped);
  },
  { eventual: true },
);
afterAll(disposeMiniflare);
