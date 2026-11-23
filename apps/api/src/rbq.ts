/**
 * `ragbaz.rbq-repository.v1` server (contracts/rbq/rbq-repository.v1.json), so
 * the real `rbq repository` CLI can describe, list, read and append here.
 *
 * Each repository is a namespace `<prefix>` inside the object store; keys are
 * stored at `<prefix><key>`. Prefixes must be non-empty: a peer must never be
 * able to add objects next to the dataset snapshots or the mail outbox.
 * Appends are immutable: identical retry 200, different bytes 409.
 */
import type { Hono } from "hono";
import { DEFAULT_LIST_LIMIT, isStorageError, parseObjectKey, readStream, toBytes, validatePrefix, type ObjectStore, type SqlStore } from "@opendata/ports";
import {
  CONTENT_SHA256_HEADER,
  ENDPOINT_PATH_PREFIX,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  MAX_OBJECT_BYTES,
  SCHEMA,
  contract,
  sha256Hex,
  timingSafeEqual,
  validEndpointId,
  validToken,
} from "@opendata/rbq";

export interface RbqRepositoryConfig {
  token: string;
  /** Namespace inside the object store, e.g. "repositories/<id>/". */
  prefix: string;
  /** Default true. */
  writable?: boolean;
  /** Bytes; appends beyond it get 409. */
  quotaBytes?: number;
}

const RESERVED = ["opendata/", "messages/", "annual-reports/", "areas/"];

export function validateRepositories(repos: Record<string, RbqRepositoryConfig>) {
  for (const [id, r] of Object.entries(repos)) {
    if (!validEndpointId(id)) throw new Error(`rbq repository id ${id} is not a lowercase UUID`);
    if (!validToken(r.token)) throw new Error(`rbq repository ${id}: token must be rbm_ + 64 hex`);
    if (!r.prefix || !r.prefix.endsWith("/")) throw new Error(`rbq repository ${id}: prefix must be non-empty and end with '/'`);
    validatePrefix(r.prefix);
    if (RESERVED.some((p) => r.prefix.startsWith(p) || p.startsWith(r.prefix))) throw new Error(`rbq repository ${id}: prefix overlaps a reserved namespace`);
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const error = (status: number) => json({ error: (contract.errors as Record<string, string>)[String(status)] ?? "error" }, status);

export function mountRbqRepositories(app: Hono, deps: { objects: ObjectStore; sql: SqlStore; publicUrl: string; repositories: Record<string, RbqRepositoryConfig> }) {
  validateRepositories(deps.repositories);
  const { objects, sql } = deps;

  const authorize = (id: string, header: string | undefined): RbqRepositoryConfig | Response => {
    if (!validEndpointId(id)) return error(404);
    const repo = deps.repositories[id];
    const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
    // Same answer for unknown ids and wrong tokens.
    if (!repo || !timingSafeEqual(presented, repo.token)) return error(401);
    return repo;
  };

  async function digestOf(id: string, repo: RbqRepositoryConfig, key: string, meta: { size: number; lastModified?: Date }) {
    const row = await sql.first<{ sha256: string; size_bytes: number; created_at: string }>("SELECT sha256, size_bytes, created_at FROM rbq_object WHERE repository = ? AND key = ?", [id, key]);
    if (row && row.size_bytes === meta.size) return row;
    const bytes = await objects.get(parseObjectKey(repo.prefix + key));
    const entry = { sha256: sha256Hex(bytes), size_bytes: bytes.length, created_at: (meta.lastModified ?? new Date()).toISOString() };
    await sql.exec(
      "INSERT INTO rbq_object (repository, key, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repository, key) DO UPDATE SET sha256 = excluded.sha256, size_bytes = excluded.size_bytes",
      [id, key, entry.sha256, entry.size_bytes, entry.created_at],
    );
    return entry;
  }

  const base = `${ENDPOINT_PATH_PREFIX}:id`;

  app.get(base, (c) => {
    const repo = authorize((c.req.param("id") ?? ""), c.req.header("authorization"));
    if (repo instanceof Response) return repo;
    return json({
      schema: SCHEMA,
      repository_id: (c.req.param("id") ?? ""),
      private: true,
      endpoint: `${deps.publicUrl.replace(/\/$/, "")}${ENDPOINT_PATH_PREFIX}${(c.req.param("id") ?? "")}`,
      capabilities: { list: true, read: true, append: repo.writable !== false },
      limits: contract.limits,
    });
  });

  app.get(`${base}/objects`, async (c) => {
    const id = (c.req.param("id") ?? "");
    const repo = authorize(id, c.req.header("authorization"));
    if (repo instanceof Response) return repo;
    const prefix = c.req.query("prefix") ?? "";
    const after = c.req.query("after");
    const limit = Number(c.req.query("limit") ?? LIST_LIMIT_DEFAULT);
    try {
      validatePrefix(prefix);
      if (after !== undefined) parseObjectKey(after);
    } catch {
      return error(404);
    }
    if (!Number.isInteger(limit) || limit < LIST_LIMIT_MIN || limit > LIST_LIMIT_MAX) return json({ error: "limit out of range" }, 400);
    const page = await objects.listPrefix(repo.prefix + prefix, { after: after === undefined ? undefined : repo.prefix + after, limit: limit + 1 });
    const items = [];
    for (const meta of page.objects.slice(0, limit)) {
      const key = meta.key.slice(repo.prefix.length);
      const d = await digestOf(id, repo, key, meta);
      items.push({ key, sha256: d.sha256, size_bytes: d.size_bytes, created_at: d.created_at });
    }
    const more = page.objects.length > limit || page.nextAfter !== undefined;
    return json({ objects: items, next_after: more && items.length ? items[items.length - 1]!.key : null });
  });

  app.get(`${base}/objects/*`, async (c) => {
    const id = (c.req.param("id") ?? "");
    const repo = authorize(id, c.req.header("authorization"));
    if (repo instanceof Response) return repo;
    const key = c.req.path.slice(`${ENDPOINT_PATH_PREFIX}${id}/objects/`.length);
    try {
      parseObjectKey(key);
      const bytes = await objects.get(parseObjectKey(repo.prefix + key));
      if (bytes.length > MAX_OBJECT_BYTES) return error(413);
      return new Response(toBytes(bytes), { headers: { "Content-Type": "application/octet-stream", [CONTENT_SHA256_HEADER]: sha256Hex(bytes), "Cache-Control": "no-store" } });
    } catch (e) {
      if (isStorageError(e, "NotFound") || isStorageError(e, "InvalidKey")) return error(404);
      throw e;
    }
  });

  app.put(`${base}/objects/*`, async (c) => {
    const id = (c.req.param("id") ?? "");
    const repo = authorize(id, c.req.header("authorization"));
    if (repo instanceof Response) return repo;
    if (repo.writable === false) return error(403);
    const key = c.req.path.slice(`${ENDPOINT_PATH_PREFIX}${id}/objects/`.length);
    try {
      parseObjectKey(key);
    } catch {
      return error(404);
    }
    if (Number(c.req.header("content-length") ?? 0) > MAX_OBJECT_BYTES) return error(413);
    let bytes: Uint8Array;
    try {
      bytes = c.req.raw.body ? await readStream(c.req.raw.body, MAX_OBJECT_BYTES) : new Uint8Array();
    } catch {
      return error(413);
    }
    const sha = sha256Hex(bytes);
    if (repo.quotaBytes !== undefined) {
      const used = await sql.first<{ n: number | null }>("SELECT sum(size_bytes) AS n FROM rbq_object WHERE repository = ?", [id]);
      if (Number(used?.n ?? 0) + bytes.length > repo.quotaBytes) return error(409);
    }
    const objectKey = parseObjectKey(repo.prefix + key);
    const outcome = await objects.putIfAbsent(objectKey, bytes);
    if (!outcome.created) {
      const existing = await objects.get(objectKey);
      if (sha256Hex(existing) !== sha) return error(409);
    }
    await sql.exec("INSERT INTO rbq_object (repository, key, sha256, size_bytes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repository, key) DO NOTHING", [
      id,
      key,
      sha,
      bytes.length,
      new Date().toISOString(),
    ]);
    return json({ key, sha256: sha, size_bytes: bytes.length, created: outcome.created }, outcome.created ? 201 : 200);
  });
}

export { DEFAULT_LIST_LIMIT };
