/**
 * rbq layer snapshots (rebsync `layer.rs`), readable and writable from both
 * runtimes. A snapshot is files split into fixed-size content-addressed chunks
 * at `<layer>/v1/chunks/sha256/<aa>/<sha256>`, written create-if-absent
 * before an immutable manifest at `<layer>/v1/snapshots/<label>/<stamp>-<digest12>.json`.
 * Manifests may come from peers, so everything read back is re-validated.
 */
import { StorageError, isStorageError, listAll, parseObjectKey, type ObjectKey, type ObjectStore } from "@opendata/ports";
import { createSha256, sha256Hex, validSha256 } from "./digest";

export const SNAPSHOT_SCHEMA = "rbq.layer.snapshot.v1";
/** rbq's own layers (rebsync `layer::LAYERS`). */
export const RBQ_LAYERS = ["mneme", "frog", "agenda", "git", "hypomnema", "binaries"] as const;
/** rbq's registered external layers (rebsync `layer::EXTERNAL_LAYERS`); this project publishes `opendata`. */
export const OPENDATA_LAYERS = ["opendata"] as const;
export const DEFAULT_CHUNK_BYTES = 65536;
const MAX_CHUNK = 64 * 1024 * 1024;

export interface Chunk {
  sha256: string;
  size: number;
}

export interface LayerFile {
  path: string;
  sha256: string;
  bytes: number;
  chunks: Chunk[];
}

/** Field set and order match rebsync's `SnapshotManifest` (deny_unknown_fields). */
export interface SnapshotManifest {
  schema: string;
  layer: string;
  id: string;
  label: string;
  created_at: string;
  run_id: string | null;
  chunk_bytes: number;
  digest: string;
  files: LayerFile[];
  owner: unknown;
}

export interface PublishOutcome {
  layer: string;
  id: string;
  manifestKey: string;
  digest: string;
  files: number;
  bytes: number;
  chunks: number;
  newChunks: number;
  reusedChunks: number;
  newBytes: number;
}

function fail(message: string): never {
  throw StorageError.corrupt(message);
}

const SAFE = /^[A-Za-z0-9._-]+$/;

export function validateLabel(label: string): void {
  if (!(label.length >= 1 && label.length <= 64 && label !== "." && label !== ".." && SAFE.test(label)))
    throw StorageError.invalidKey("label must be 1..64 of ASCII letters, digits, '.', '-' or '_'");
}

export function validateLayer(layer: string, allowed: readonly string[] = [...RBQ_LAYERS, ...OPENDATA_LAYERS]): void {
  if (!allowed.includes(layer)) throw StorageError.invalidKey(`unknown layer ${JSON.stringify(layer)}`);
}

/** Relative path from an untrusted manifest: plain safe segments. */
export function validateRelativePath(path: string): void {
  if (!(path.length >= 1 && path.length <= 512)) fail("file path must be 1..512 bytes");
  if (path.includes("\\")) fail("backslash in path");
  if (path.startsWith("/")) fail(`path ${JSON.stringify(path)} must be relative`);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      fail(`path ${JSON.stringify(path)} must be relative without '.' or '..'`);
    if (segment.startsWith(".") && segment !== ".rbq-keep") fail(`hidden path segment ${JSON.stringify(segment)}`);
    if (!SAFE.test(segment)) fail(`unsupported character in ${JSON.stringify(segment)}`);
  }
}

const layerPrefix = (layer: string) => `${layer}/v1`;

export function chunkKey(prefix: string, sha256: string): ObjectKey {
  if (!validSha256(sha256)) fail("invalid chunk digest");
  return parseObjectKey(`${prefix}/chunks/sha256/${sha256.slice(0, 2)}/${sha256}`);
}

export function manifestKey(layer: string, id: string, allowed?: readonly string[]): ObjectKey {
  validateLayer(layer, allowed);
  const slash = id.indexOf("/");
  if (slash < 0) throw StorageError.invalidKey("snapshot id must be <label>/<name>");
  const label = id.slice(0, slash);
  const name = id.slice(slash + 1);
  validateLabel(label);
  if (name.length === 0 || name.includes("/")) throw StorageError.invalidKey("snapshot id must be <label>/<name>");
  return parseObjectKey(`${layerPrefix(layer)}/snapshots/${label}/${name}.json`);
}

/** SHA-256 over sorted `path\0sha256\n` lines. */
export function contentDigest(files: LayerFile[]): string {
  const lines = files.map((f) => `${f.path}\0${f.sha256}\n`).sort();
  return sha256Hex(new TextEncoder().encode(lines.join("")));
}

/** `%Y%m%dT%H%M%S%.3fZ` as rebsync's chrono format. */
export function stamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}.${p(date.getUTCMilliseconds(), 3)}Z`
  );
}

/** Write a chunk unless existing bytes verify against its address (rbq `put_chunk`). */
export async function putChunk(store: ObjectStore, prefix: string, data: Uint8Array): Promise<{ chunk: Chunk; created: boolean }> {
  const sha256 = sha256Hex(data);
  const key = chunkKey(prefix, sha256);
  const size = data.length;
  const verifyExisting = async () => {
    const actual = await store.get(key);
    if (actual.length !== size || sha256Hex(actual) !== sha256) fail(`${key}: existing chunk digest or size mismatch`);
  };
  try {
    const meta = await store.head(key);
    if (meta.size !== size) fail(`${key}: stored ${meta.size} bytes, expected ${size}`);
    await verifyExisting();
    return { chunk: { sha256, size }, created: false };
  } catch (error) {
    if (!isStorageError(error, "NotFound")) throw error;
  }
  const outcome = await store.putIfAbsent(key, data);
  if (!outcome.created) {
    if (outcome.meta.size !== size) fail(`${key}: stored ${outcome.meta.size} bytes, expected ${size}`);
    await verifyExisting();
  }
  return { chunk: { sha256, size }, created: outcome.created };
}

export interface SnapshotInput {
  path: string;
  data: Uint8Array;
}

export interface PublishOptions {
  layer: string;
  label: string;
  files: SnapshotInput[];
  owner: unknown;
  chunkBytes?: number;
  runId?: string | null;
  now?: Date;
  allowedLayers?: readonly string[];
}

/** Publish in-memory files as a snapshot: chunks first, manifest last. */
export async function publishSnapshot(store: ObjectStore, options: PublishOptions): Promise<PublishOutcome> {
  const { layer, label, owner } = options;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  validateLayer(layer, options.allowedLayers);
  validateLabel(label);
  if (options.files.length === 0) throw new TypeError("a snapshot needs at least one file");
  if (!(chunkBytes >= 4096 && chunkBytes <= MAX_CHUNK && chunkBytes % 4096 === 0))
    throw new RangeError("chunk_bytes must be a multiple of 4096 in 4 KiB..64 MiB");
  const prefix = layerPrefix(layer);
  const files: LayerFile[] = [];
  let newChunks = 0;
  let newBytes = 0;
  const seen = new Set<string>();
  for (const input of options.files) {
    validateRelativePath(input.path);
    if (seen.has(input.path)) throw new TypeError(`duplicate path ${input.path}`);
    seen.add(input.path);
    const chunks: Chunk[] = [];
    for (let offset = 0; offset < input.data.length; offset += chunkBytes) {
      const slice = input.data.subarray(offset, Math.min(offset + chunkBytes, input.data.length));
      const { chunk, created } = await putChunk(store, prefix, slice);
      chunks.push(chunk);
      if (created) {
        newChunks++;
        newBytes += chunk.size;
      }
    }
    files.push({ path: input.path, sha256: sha256Hex(input.data), bytes: input.data.length, chunks });
  }
  const digest = contentDigest(files);
  const now = options.now ?? new Date();
  const id = `${label}/${stamp(now)}-${digest.slice(0, 12)}`;
  const manifest: SnapshotManifest = {
    schema: SNAPSHOT_SCHEMA,
    layer,
    id,
    label,
    created_at: now.toISOString(),
    run_id: options.runId ?? null,
    chunk_bytes: chunkBytes,
    digest,
    files,
    owner,
  };
  const key = manifestKey(layer, id, options.allowedLayers);
  const outcome = await store.putIfAbsent(key, JSON.stringify(manifest, null, 2));
  if (!outcome.created) throw StorageError.alreadyExists(`manifest ${key} already exists; not overwriting`);
  const total = files.reduce((n, f) => n + f.chunks.length, 0);
  return {
    layer,
    id,
    manifestKey: key,
    digest,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    chunks: total,
    newChunks,
    reusedChunks: total - newChunks,
    newBytes,
  };
}

const MANIFEST_FIELDS = ["schema", "layer", "id", "label", "created_at", "run_id", "chunk_bytes", "digest", "files", "owner"];

/** Validate an untrusted manifest (rbq `check_manifest` plus field allow-list). */
export function checkManifest(value: unknown, layer: string, id: string): SnapshotManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("manifest is not an object");
  for (const key of Object.keys(value)) if (!MANIFEST_FIELDS.includes(key)) fail(`unknown manifest field ${key}`);
  const m = value as SnapshotManifest;
  if (m.schema !== SNAPSHOT_SCHEMA) fail("unsupported snapshot schema");
  if (m.layer !== layer) fail("manifest belongs to another layer");
  if (m.id !== id) fail("manifest id does not match its key");
  if (typeof m.digest !== "string" || !validSha256(m.digest)) fail("invalid manifest digest");
  if (!Array.isArray(m.files) || m.files.length === 0) fail("manifest lists no files");
  if (typeof m.created_at !== "string" || Number.isNaN(Date.parse(m.created_at))) fail("invalid created_at");
  const seen = new Set<string>();
  let total = 0;
  for (const file of m.files) {
    if (typeof file.path !== "string") fail("file path is not a string");
    validateRelativePath(file.path);
    if (seen.has(file.path)) fail(`duplicate path ${file.path}`);
    seen.add(file.path);
    if (typeof file.sha256 !== "string" || !validSha256(file.sha256)) fail("invalid file digest");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) fail("invalid file size");
    if (!Array.isArray(file.chunks)) fail("chunks is not a list");
    let sum = 0;
    for (const chunk of file.chunks) {
      if (typeof chunk.sha256 !== "string" || !validSha256(chunk.sha256)) fail("invalid chunk digest");
      if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > MAX_CHUNK) fail("invalid chunk size");
      sum += chunk.size;
    }
    if (sum !== file.bytes) fail(`chunk sizes of ${file.path} do not add up`);
    total += file.bytes;
    if (!Number.isSafeInteger(total)) fail("manifest byte count overflows");
  }
  if (contentDigest(m.files) !== m.digest) fail("manifest digest does not match its file list");
  return m;
}

export async function loadManifest(store: ObjectStore, layer: string, id: string, allowed?: readonly string[]): Promise<SnapshotManifest> {
  const key = manifestKey(layer, id, allowed);
  const bytes = await store.get(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`unreadable manifest ${key}`);
  }
  return checkManifest(parsed, layer, id);
}

/** Snapshots of a layer (optionally one label), oldest first. */
export async function listSnapshots(store: ObjectStore, layer: string, label?: string, allowed?: readonly string[]): Promise<SnapshotManifest[]> {
  validateLayer(layer, allowed);
  const base = `${layerPrefix(layer)}/snapshots/`;
  if (label !== undefined) validateLabel(label);
  const wanted = label === undefined ? base : `${base}${label}/`;
  const found: SnapshotManifest[] = [];
  for await (const meta of listAll(store, wanted)) {
    if (!meta.key.endsWith(".json")) continue;
    const id = meta.key.slice(base.length, -".json".length);
    found.push(await loadManifest(store, layer, id, allowed));
  }
  return found.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
}

/** Stream one file of a snapshot, verifying every chunk and the whole-file digest. */
export async function* readFileChunks(store: ObjectStore, manifest: SnapshotManifest, path: string): AsyncGenerator<Uint8Array> {
  checkManifest(manifest, manifest.layer, manifest.id);
  const file = manifest.files.find((f) => f.path === path);
  if (!file) throw StorageError.notFound(`${path} is not in snapshot ${manifest.id}`);
  const prefix = layerPrefix(manifest.layer);
  const whole = createSha256();
  for (const [index, chunk] of file.chunks.entries()) {
    const data = await store.get(chunkKey(prefix, chunk.sha256));
    if (data.length !== chunk.size || sha256Hex(data) !== chunk.sha256) fail(`${file.path}: chunk ${index} (${chunk.sha256}) is damaged`);
    whole.update(data);
    yield data;
  }
  if (whole.hex() !== file.sha256) fail(`${file.path}: reassembled digest does not match`);
}

/** Reassemble one file in memory. */
export async function readFile(store: ObjectStore, manifest: SnapshotManifest, path: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of readFileChunks(store, manifest, path)) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface FsckReport {
  snapshots: number;
  damaged: { id: string; error: string }[];
  missingChunks: number;
  orphanChunks: number;
}

/** Structural check of a layer (rbq `storage fsck`), read-only. */
export async function fsckLayer(store: ObjectStore, layer: string, allowed?: readonly string[]): Promise<FsckReport> {
  const prefix = layerPrefix(layer);
  const referenced = new Set<string>();
  const report: FsckReport = { snapshots: 0, damaged: [], missingChunks: 0, orphanChunks: 0 };
  const base = `${prefix}/snapshots/`;
  for await (const meta of listAll(store, base)) {
    if (!meta.key.endsWith(".json")) continue;
    report.snapshots++;
    const id = meta.key.slice(base.length, -".json".length);
    try {
      const manifest = await loadManifest(store, layer, id, allowed);
      for (const file of manifest.files) {
        for (const chunk of file.chunks) referenced.add(chunk.sha256);
        for await (const _ of readFileChunks(store, manifest, file.path)) void _;
      }
    } catch (error) {
      if (isStorageError(error, "NotFound")) report.missingChunks++;
      report.damaged.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  for await (const meta of listAll(store, `${prefix}/chunks/sha256/`)) {
    const sha = meta.key.slice(meta.key.lastIndexOf("/") + 1);
    if (!referenced.has(sha)) report.orphanChunks++;
  }
  return report;
}
