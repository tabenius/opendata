import {
  DEFAULT_LIST_LIMIT,
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

interface Entry {
  data: Uint8Array;
  lastModified: Date;
  etag: string;
}

/** In-memory store for tests and the test runtime. Copies on write and read. */
export class MemoryObjectStore implements ObjectStore {
  readonly name = "memory";
  private readonly objects = new Map<string, Entry>();
  private counter = 0;

  capabilities(): StorageCapabilities {
    return {
      atomicCreateIfAbsent: true,
      ownerOnlyPermissions: true,
      durablePublication: false,
      rangeReads: true,
      rawPrefixListing: true,
      maxKeyBytes: MAX_KEY_BYTES,
    };
  }

  private meta(key: string, entry: Entry): ObjectMeta {
    return { key, size: entry.data.length, lastModified: entry.lastModified, etag: entry.etag };
  }

  private store(key: ObjectKey, data: Bytes): ObjectMeta {
    const entry = { data: toBytes(data).slice(), lastModified: new Date(), etag: `"m${++this.counter}"` };
    this.objects.set(key, entry);
    return this.meta(key, entry);
  }

  private entry(key: ObjectKey): Entry {
    const entry = this.objects.get(key);
    if (!entry) throw StorageError.notFound(key);
    return entry;
  }

  async put(key: ObjectKey, data: Bytes) {
    return this.store(key, data);
  }

  async putIfAbsent(key: ObjectKey, data: Bytes): Promise<PutOutcome> {
    const existing = this.objects.get(key);
    if (existing) return { created: false, meta: this.meta(key, existing) };
    return { created: true, meta: this.store(key, data) };
  }

  async get(key: ObjectKey) {
    return this.entry(key).data.slice();
  }

  async getStream(key: ObjectKey) {
    const data = this.entry(key).data.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  async getRange(key: ObjectKey, range: { start: number; end: number }) {
    if (range.start >= range.end) throw StorageError.invalidKey(`empty or inverted range ${range.start}..${range.end}`);
    const data = this.entry(key).data;
    if (range.start >= data.length) throw StorageError.invalidKey("range starts beyond the object");
    return data.slice(range.start, Math.min(range.end, data.length));
  }

  async head(key: ObjectKey) {
    return this.meta(key, this.entry(key));
  }

  async listPrefix(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    validatePrefix(prefix);
    const limit = options.limit || DEFAULT_LIST_LIMIT;
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (options.after === undefined || k > options.after))
      .sort();
    const page = keys.slice(0, limit);
    return {
      objects: page.map((k) => this.meta(k, this.objects.get(k)!)),
      nextAfter: keys.length > limit ? page[page.length - 1] : undefined,
    };
  }

  async delete(key: ObjectKey) {
    this.objects.delete(key);
  }
}
