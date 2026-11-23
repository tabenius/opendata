/**
 * Any S3-compatible service (AWS S3, R2's S3 API, MinIO, Garage) over fetch
 * with SigV4 from aws4fetch, so it runs on Workers and Node alike.
 * Create-if-absent is `If-None-Match: *` (412 when the key exists).
 * Listing is ListObjectsV2 with a raw prefix and `start-after`.
 */
import { AwsClient } from "aws4fetch";
import {
  MAX_KEY_BYTES,
  StorageError,
  readStream,
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

export interface S3Config {
  /** e.g. https://ACCOUNT.r2.cloudflarestorage.com or http://127.0.0.1:9000 */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Key prefix inside the bucket, e.g. "opendata-store/". */
  root?: string;
  fetch?: typeof fetch;
}

const S3_LIST_MAX = 1000;

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]!) : undefined;
}

export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly root: string;

  constructor(private readonly config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: config.region ?? "auto",
    });
    this.base = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}`;
    this.root = config.root ?? "";
    if (this.root && !this.root.endsWith("/")) throw new TypeError("S3 root must end with '/'");
  }

  capabilities(): StorageCapabilities {
    return {
      atomicCreateIfAbsent: true,
      ownerOnlyPermissions: true,
      durablePublication: true,
      rangeReads: true,
      rawPrefixListing: true,
      maxKeyBytes: MAX_KEY_BYTES - this.root.length,
    };
  }

  private url(key: string): string {
    return `${this.base}/${(this.root + key).split("/").map(encodeURIComponent).join("/")}`;
  }

  private async call(key: string, init: RequestInit & { url?: string }): Promise<Response> {
    let response: Response;
    try {
      const request = await this.client.sign(init.url ?? this.url(key), init);
      response = await (this.config.fetch ?? fetch)(request);
    } catch (error) {
      throw StorageError.unavailable(`${key}: ${(error as Error).message}`, error);
    }
    return response;
  }

  private async fail(response: Response, key: string): Promise<never> {
    const text = await response.text().catch(() => "");
    const code = tag(text, "Code") ?? String(response.status);
    if (response.status === 404) throw StorageError.notFound(key);
    if (response.status === 403) throw new StorageError("PermissionDenied", `${key}: ${code}`);
    if (response.status === 503 || response.status === 429) throw StorageError.unavailable(`${key}: ${code}`);
    throw StorageError.backend(`${key}: HTTP ${response.status} ${code}`);
  }

  private metaFrom(key: string, response: Response, size?: number): ObjectMeta {
    const modified = response.headers.get("last-modified");
    return {
      key,
      size: size ?? Number(response.headers.get("content-length") ?? 0),
      lastModified: modified ? new Date(modified) : undefined,
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  async put(key: ObjectKey, data: Bytes) {
    const body = toBytes(data);
    const response = await this.call(key, { method: "PUT", body });
    if (!response.ok) return this.fail(response, key);
    await response.body?.cancel();
    return this.metaFrom(key, response, body.length);
  }

  async putIfAbsent(key: ObjectKey, data: Bytes): Promise<PutOutcome> {
    const body = toBytes(data);
    const response = await this.call(key, { method: "PUT", body, headers: { "If-None-Match": "*" } });
    if (response.status === 412 || response.status === 409) {
      await response.body?.cancel();
      return { created: false, meta: await this.head(key) };
    }
    if (!response.ok) return this.fail(response, key);
    await response.body?.cancel();
    return { created: true, meta: this.metaFrom(key, response, body.length) };
  }

  async get(key: ObjectKey) {
    return readStream(await this.getStream(key));
  }

  async getStream(key: ObjectKey) {
    const response = await this.call(key, { method: "GET" });
    if (!response.ok || !response.body) return this.fail(response, key);
    return response.body as ReadableStream<Uint8Array>;
  }

  async getRange(key: ObjectKey, range: { start: number; end: number }) {
    if (range.start >= range.end) throw StorageError.invalidKey(`empty or inverted range ${range.start}..${range.end}`);
    const response = await this.call(key, { method: "GET", headers: { Range: `bytes=${range.start}-${range.end - 1}` } });
    if (response.status === 416) {
      await response.body?.cancel();
      throw StorageError.invalidKey("range starts beyond the object");
    }
    if (!response.ok) return this.fail(response, key);
    return new Uint8Array(await response.arrayBuffer());
  }

  async head(key: ObjectKey) {
    const response = await this.call(key, { method: "HEAD" });
    if (!response.ok) {
      if (response.status === 404) throw StorageError.notFound(key);
      return this.fail(response, key);
    }
    return this.metaFrom(key, response);
  }

  async listPrefix(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    validatePrefix(prefix);
    const limit = Math.min(options.limit || S3_LIST_MAX, S3_LIST_MAX);
    const params = new URLSearchParams({ "list-type": "2", prefix: this.root + prefix, "max-keys": String(limit) });
    if (options.after) params.set("start-after", this.root + options.after);
    const response = await this.call(prefix, { method: "GET", url: `${this.base}?${params}` });
    if (!response.ok) return this.fail(response, prefix);
    const xml = await response.text();
    const objects: ObjectMeta[] = [];
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = match[1]!;
      const full = tag(body, "Key") ?? "";
      const modified = tag(body, "LastModified");
      objects.push({
        key: full.slice(this.root.length),
        size: Number(tag(body, "Size") ?? 0),
        lastModified: modified ? new Date(modified) : undefined,
        etag: tag(body, "ETag"),
      });
    }
    const truncated = tag(xml, "IsTruncated") === "true";
    return { objects, nextAfter: truncated && objects.length ? objects[objects.length - 1]!.key : undefined };
  }

  async delete(key: ObjectKey) {
    const response = await this.call(key, { method: "DELETE" });
    if (!response.ok && response.status !== 404) return this.fail(response, key);
    await response.body?.cancel();
  }
}
