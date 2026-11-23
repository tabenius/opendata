/** One shared Miniflare (workerd) instance exposing real R2, KV and D1 bindings to Node tests. */
import { Miniflare } from "miniflare";

let instance: Miniflare | undefined;

export function miniflare(): Miniflare {
  instance ??= new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    r2Buckets: ["BUCKET"],
    kvNamespaces: ["KV"],
    d1Databases: ["DB"],
    compatibilityDate: "2025-09-01",
  });
  return instance;
}

export async function disposeMiniflare() {
  await instance?.dispose();
  instance = undefined;
}
