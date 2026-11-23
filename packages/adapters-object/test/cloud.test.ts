import { afterAll, describe, expect, it } from "vitest";
import { AwsClient } from "aws4fetch";
import { objectStoreConformance } from "@opendata/conformance";
import { disposeMiniflare, miniflare } from "@opendata/conformance/miniflare";
import { parseObjectKey } from "@opendata/ports";
import { R2ObjectStore, type R2BucketLike } from "../src/r2";
import { S3ObjectStore } from "../src/s3";

let r2Prefix = 0;
/** Each test gets its own key namespace inside the one Miniflare bucket. */
class Prefixed extends R2ObjectStore {}

objectStoreConformance("r2 (miniflare)", async () => {
  const bucket = (await miniflare().getR2Bucket("BUCKET")) as unknown as R2BucketLike;
  const root = `t${++r2Prefix}/`;
  type Obj = { key: string; size: number; etag: string; httpEtag: string; uploaded: Date };
  const plain = (o: Obj) => ({ key: o.key.slice(root.length), size: o.size, etag: o.etag, httpEtag: o.httpEtag, uploaded: o.uploaded });
  const scoped: R2BucketLike = {
    head: async (k) => {
      const o = await bucket.head(root + k);
      return o && plain(o);
    },
    get: async (k, opts) => {
      const o = await bucket.get(root + k, opts);
      return o && { ...plain(o), get body() { return o.body; }, arrayBuffer: () => o.arrayBuffer() };
    },
    put: async (k, v, opts) => {
      const o = await bucket.put(root + k, v, opts);
      return o && plain(o);
    },
    delete: (k) => bucket.delete(root + k),
    list: async (o) => {
      const r = await bucket.list({ ...o, prefix: root + (o?.prefix ?? ""), startAfter: o?.startAfter ? root + o.startAfter : undefined });
      return { truncated: r.truncated, cursor: r.cursor, objects: r.objects.map(plain) };
    },
  };
  return new Prefixed(scoped);
});

afterAll(disposeMiniflare);

describe("r2 conditional create", () => {
  it("uses the binding's onlyIf so a second writer gets null", async () => {
    const bucket = (await miniflare().getR2Bucket("BUCKET")) as unknown as R2BucketLike;
    const store = new R2ObjectStore(bucket);
    expect((await store.putIfAbsent(parseObjectKey("cond/a"), "1")).created).toBe(true);
    expect((await store.putIfAbsent(parseObjectKey("cond/a"), "22")).created).toBe(false);
  });
});

const endpoint = process.env.S3_TEST_ENDPOINT;
if (endpoint) {
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const aws = new AwsClient({ ...credentials, service: "s3", region: "us-east-1" });
  let n = 0;
  objectStoreConformance("s3 (moto)", async () => {
    const bucket = `od-test-${Date.now()}-${++n}`;
    const res = await aws.fetch(`${endpoint}/${bucket}`, { method: "PUT" });
    if (!res.ok) throw new Error(`create bucket: ${res.status}`);
    return new S3ObjectStore({ endpoint, bucket, region: "us-east-1", ...credentials, root: "store/" });
  });
}
