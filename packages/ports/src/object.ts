import type { Bytes } from "./bytes";
import type { ObjectKey } from "./keys";

/** rbq `StorageCapabilities`, camelCased. Adapters must not over-claim. */
export interface StorageCapabilities {
  atomicCreateIfAbsent: boolean;
  ownerOnlyPermissions: boolean;
  durablePublication: boolean;
  rangeReads: boolean;
  rawPrefixListing: boolean;
  maxKeyBytes: number;
}

/** ETags are opaque validators, not content hashes. */
export interface ObjectMeta {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
}

export type PutOutcome = { created: true; meta: ObjectMeta } | { created: false; meta: ObjectMeta };

export interface ListPage {
  objects: ObjectMeta[];
  /** Pass as `after` to continue; undefined when exhausted. */
  nextAfter?: string;
}

export interface ListOptions {
  /** Exclusive lower bound (a key), as rbq-repository.v1 `after`. */
  after?: string;
  /** 0 or undefined: adapter default page size. */
  limit?: number;
}

/**
 * Files. Semantics of rbq's `ObjectStorage`, made async.
 * `listPrefix` is raw string-prefix listing sorted by key, not a directory listing.
 * `delete` is for administration only; nothing synchronises deletions.
 */
export interface ObjectStore {
  readonly name: string;
  capabilities(): StorageCapabilities;
  put(key: ObjectKey, data: Bytes): Promise<ObjectMeta>;
  putIfAbsent(key: ObjectKey, data: Bytes): Promise<PutOutcome>;
  get(key: ObjectKey): Promise<Uint8Array>;
  getStream(key: ObjectKey): Promise<ReadableStream<Uint8Array>>;
  /** Half-open byte range [start, end). */
  getRange(key: ObjectKey, range: { start: number; end: number }): Promise<Uint8Array>;
  head(key: ObjectKey): Promise<ObjectMeta>;
  listPrefix(prefix: string, options?: ListOptions): Promise<ListPage>;
  delete(key: ObjectKey): Promise<void>;
}

export const DEFAULT_LIST_LIMIT = 1000;

/** Iterate every object under a prefix. */
export async function* listAll(store: ObjectStore, prefix: string, pageSize = DEFAULT_LIST_LIMIT) {
  let after: string | undefined;
  for (;;) {
    const page = await store.listPrefix(prefix, { after, limit: pageSize });
    for (const object of page.objects) yield object;
    if (!page.nextAfter) return;
    after = page.nextAfter;
  }
}
