/**
 * Client for `ragbaz.rbq-repository.v1` (rebsync `repository.rs`): HTTPS only
 * (loopback HTTP allowed), bearer token in the header, redirects refused,
 * bounded responses, hash-verified reads, acknowledged immutable appends.
 */
import { parseObjectKey, readStream, toBytes, validatePrefix, type Bytes } from "@opendata/ports";
import {
  CONTENT_SHA256_HEADER,
  ENDPOINT_PATH_PREFIX,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  MAX_OBJECT_BYTES,
  SCHEMA,
  validEndpointId,
  validToken,
} from "./contract";
import { sha256Hex } from "./digest";

const MAX_JSON_BYTES = 262144;

export interface ListedObject {
  key: string;
  sha256: string;
  size_bytes: number;
  created_at: string;
}

export interface ListResponse {
  objects: ListedObject[];
  next_after: string | null;
}

export interface AppendResponse {
  key: string;
  sha256: string;
  size_bytes: number;
  created: boolean;
}

export const STATUS_MESSAGES: Record<number, string> = {
  401: "credential expired or revoked",
  403: "storage not enabled for this credential, or bad origin",
  404: "object or route not found",
  409: "immutable key conflict or repository quota exceeded",
  413: "object exceeds the size limit",
  429: "rate limited",
};

export class RepositoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}

export function validateEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) throw new TypeError("endpoint must not contain credentials, query or fragment");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new TypeError("endpoint must use https (http only on loopback)");
  if (!url.pathname.startsWith(ENDPOINT_PATH_PREFIX)) throw new TypeError(`endpoint path must start with ${ENDPOINT_PATH_PREFIX}`);
  const id = url.pathname.slice(ENDPOINT_PATH_PREFIX.length).replace(/\/$/, "");
  if (!validEndpointId(id)) throw new TypeError("endpoint id must be a lowercase UUID");
  url.pathname = `${ENDPOINT_PATH_PREFIX}${id}`;
  return url;
}

export class RepositoryClient {
  private readonly base: URL;

  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!validToken(token)) throw new TypeError("token must be rbm_ or rbs_ followed by 64 lowercase hex digits");
    this.base = validateEndpoint(endpoint);
  }

  private async request(method: string, suffix: string, init?: { query?: Record<string, string>; body?: Uint8Array<ArrayBuffer> }) {
    const url = new URL(this.base.href + suffix);
    for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v);
    const response = await this.fetcher(url, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "opendata-rbq/0.1",
        ...(init?.body ? { "Content-Type": "application/octet-stream" } : {}),
      },
      body: init?.body,
    });
    if (response.status >= 300 && response.status < 400) throw new RepositoryError(response.status, "redirects are refused");
    if (!response.ok) {
      await response.body?.cancel();
      throw new RepositoryError(response.status, STATUS_MESSAGES[response.status] ?? `repository returned HTTP ${response.status}`);
    }
    return response;
  }

  private async json<T>(response: Response): Promise<T> {
    const bytes = response.body ? await readStream(response.body, MAX_JSON_BYTES) : new Uint8Array();
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  async describe(): Promise<Record<string, unknown>> {
    const value = await this.json<Record<string, unknown>>(await this.request("GET", ""));
    if (value.schema !== SCHEMA || value.private !== true) throw new TypeError("unsupported private repository descriptor");
    return value;
  }

  async list(prefix = "", after?: string, limit = LIST_LIMIT_DEFAULT): Promise<ListResponse> {
    validatePrefix(prefix);
    if (after !== undefined) parseObjectKey(after);
    if (!(limit >= LIST_LIMIT_MIN && limit <= LIST_LIMIT_MAX)) throw new RangeError(`list limit must be ${LIST_LIMIT_MIN}..${LIST_LIMIT_MAX}`);
    const query: Record<string, string> = { prefix, limit: String(limit) };
    if (after !== undefined) query.after = after;
    return this.json<ListResponse>(await this.request("GET", "/objects", { query }));
  }

  async read(key: string): Promise<Uint8Array> {
    parseObjectKey(key);
    const response = await this.request("GET", `/objects/${key}`);
    const expected = response.headers.get(CONTENT_SHA256_HEADER);
    if (!expected) throw new TypeError("repository omitted content digest");
    const bytes = response.body ? await readStream(response.body, MAX_OBJECT_BYTES) : new Uint8Array();
    if (sha256Hex(bytes) !== expected) throw new TypeError("repository content digest mismatch");
    return bytes;
  }

  async append(key: string, data: Bytes): Promise<AppendResponse> {
    parseObjectKey(key);
    const bytes = toBytes(data);
    if (bytes.length > MAX_OBJECT_BYTES) throw new RangeError("object exceeds 256 KiB; split larger objects before appending");
    const value = await this.json<AppendResponse>(await this.request("PUT", `/objects/${key}`, { body: bytes }));
    if (value.key !== key || typeof value.created !== "boolean" || value.sha256 !== sha256Hex(bytes) || value.size_bytes !== bytes.length)
      throw new TypeError("repository append acknowledgement mismatch");
    return value;
  }
}
