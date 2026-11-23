/**
 * Cloudflare R2 through a Worker binding. Create-if-absent uses R2's
 * conditional put (`onlyIf`), which returns null when the precondition fails,
 * so there is no HEAD-then-PUT race.
 */
import {
  MAX_KEY_BYTES,
  StorageError,
  toBytes,
  validatePrefix,
  type Bytes,
  type ListOptions,
  type ListPage,
  type ObjectKey,
  type ObjectMeta,
  type ObjectStore,
  type PutOutcome,
  type StorageCapabilities,
} from "@opendata/ports";

/** The subset of the R2Bucket binding used here (structural, no global types). */
export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { onlyIf?: unknown }): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; startAfter?: string; cursor?: string }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

const R2_LIST_MAX = 1000;

function meta(object: R2ObjectLike): ObjectMeta {
  return { key: object.key, size: object.size, lastModified: object.uploaded, etag: object.httpEtag };
}

function wrap(error: unknown, key: string): never {
  if (error instanceof StorageError) throw error;
  throw StorageError.backend(`${key}: ${(error as Error)?.message ?? error}`, error);
}

export class R2ObjectStore implements ObjectStore {
  readonly name = "r2";
  constructor(private readonly bucket: R2BucketLike) {}

  capabilities(): StorageCapabilities {
    return {
      atomicCreateIfAbsent: true,
      ownerOnlyPermissions: true,
      durablePublication: true,
      rangeReads: true,
      rawPrefixListing: true,
      maxKeyBytes: MAX_KEY_BYTES,
    };
  }

  async put(key: ObjectKey, data: Bytes) {
    try {
      const result = await this.bucket.put(key, toBytes(data));
      if (!result) throw StorageError.backend(`${key}: put returned nothing`);
      return meta(result);
    } catch (error) {
      wrap(error, key);
    }
  }

  async putIfAbsent(key: ObjectKey, data: Bytes): Promise<PutOutcome> {
    let result: R2ObjectLike | null;
    try {
      result = await this.bucket.put(key, toBytes(data), { onlyIf: { etagDoesNotMatch: "*" } });
    } catch (error) {
      wrap(error, key);
    }
    if (result) return { created: true, meta: meta(result) };
    return { created: false, meta: await this.head(key) };
  }

  private async body(key: ObjectKey, range?: { offset: number; length: number }) {
    let object: R2ObjectBodyLike | null;
    try {
      object = await this.bucket.get(key, range ? { range } : undefined);
    } catch (error) {
      wrap(error, key);
    }
    if (!object) throw StorageError.notFound(key);
    return object;
  }

  async get(key: ObjectKey) {
    return new Uint8Array(await (await this.body(key)).arrayBuffer());
  }

  async getStream(key: ObjectKey) {
    return (await this.body(key)).body;
  }

  async getRange(key: ObjectKey, range: { start: number; end: number }) {
    if (range.start >= range.end) throw StorageError.invalidKey(`empty or inverted range ${range.start}..${range.end}`);
    const head = await this.head(key);
    if (range.start >= head.size) throw StorageError.invalidKey("range starts beyond the object");
    const length = Math.min(range.end, head.size) - range.start;
    return new Uint8Array(await (await this.body(key, { offset: range.start, length })).arrayBuffer());
  }

  async head(key: ObjectKey) {
    let object: R2ObjectLike | null;
    try {
      object = await this.bucket.head(key);
    } catch (error) {
      wrap(error, key);
    }
    if (!object) throw StorageError.notFound(key);
    return meta(object);
  }

  async listPrefix(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    validatePrefix(prefix);
    const limit = Math.min(options.limit || R2_LIST_MAX, R2_LIST_MAX);
    const result = await this.bucket.list({ prefix, limit, ...(options.after ? { startAfter: options.after } : {}) });
    const objects = result.objects.map(meta);
    return { objects, nextAfter: result.truncated && objects.length ? objects[objects.length - 1]!.key : undefined };
  }

  async delete(key: ObjectKey) {
    await this.bucket.delete(key);
  }
}
