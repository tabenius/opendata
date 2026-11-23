# rbq compatibility

How opendata's storage layers stay compatible with rbq (Rebeqah),
`tabenius/rebsync` at commit `8023dcb7e49f1577b9bc639ea9c3773ba06f09ba`.

rbq gives us three reusable things. It has **no** KV, SQL or mail
abstraction, so those are defined here *in terms of* the three:

| rbq piece | Source | What we reuse |
|---|---|---|
| Object storage contract | `crates/rebsync-core/src/storage.rs` | key grammar, operations, capabilities, error taxonomy |
| Layer snapshots | `crates/rebsync-core/src/layer.rs` | chunked, content-addressed, manifest-last publication |
| Wire contract `ragbaz.rbq-repository.v1` | `contracts/rbq-repository.v1.json`, `wire.rs`, `repository.rs`, `transport.rs` | HTTP routes, digests, headers, limits, token/endpoint formats, conformance vectors |

## 1. Shared primitives (`packages/rbq`)

Ported verbatim in behaviour, tested against the vendored contract vectors.

| rbq | opendata TS |
|---|---|
| `ObjectKey::parse` — ASCII `[A-Za-z0-9._-]` segments, `/`, ≤1024 B key, ≤255 B segment, no empty/`.`/`..` | `parseObjectKey()` → branded `ObjectKey` |
| `validate_prefix` — may end mid-segment, at most one trailing `/` | `validatePrefix()` |
| `wire::sha256_hex` — lowercase hex | `sha256Hex()` (WebCrypto `crypto.subtle.digest`, both runtimes) |
| `x-content-sha256` header | `CONTENT_SHA256_HEADER` |
| `rbm_` + 64 lowercase hex bearer token | `validToken()` |
| lowercase hyphenated UUID endpoint id | `validEndpointId()` |
| `MAX_OBJECT_BYTES = 262144`, list limit 1..100, default 20 | same constants, imported from the vendored JSON |
| HTTP client: no redirects, bearer in header only, bounded reads | `rbqFetch()` wrapper: `redirect: "manual"` → error, size-capped body reader |

The JSON contract is vendored under `contracts/rbq/` with a `SHA256SUMS`
(the same pattern rebsync uses for the ragbaz component schema). CI fails if
the checksum or any vector disagrees. rebsync owns the contract; we follow it.

## 2. Files → `ObjectStore`

| rbq `ObjectStorage` (sync Rust) | `ObjectStore` (async TS) | Notes |
|---|---|---|
| `capabilities()` | `capabilities()` | Same fields, camelCase: `atomicCreateIfAbsent`, `ownerOnlyPermissions`, `durablePublication`, `rangeReads`, `rawPrefixListing`, `maxKeyBytes` |
| `put` | `put` | create or replace; not used for layer/messages data |
| `put_if_absent` → `Created`/`AlreadyExists` | `putIfAbsent` → `{created: true\|false, meta}` | R2 `onlyIf etagDoesNotMatch:"*"`, S3 `If-None-Match:*`, fs hard-link publish |
| `get`, `get_range`, `head` | same | plus `getStream` (Worker memory) |
| `list_prefix(prefix, limit)` raw, sorted | `listPrefix(prefix, {after, limit})` | `after` matches rbq-repository.v1 paging |
| `delete` (admin only) | `delete` | never called by sync/ingest |
| `StorageError::*` | `StorageError` discriminated union, same 8 kinds | HTTP mapping copied from `transport.rs::storage_response` |

**The fs adapter uses the rbq store layout**, so an opendata Linux object root
*is* an rbq object store: `rbq storage check/fsck --storage-root <root>` works
on it directly. On FAT/exFAT it reports `atomicCreateIfAbsent: false`,
exactly as rbq does.

## 3. SQL → owner-exported snapshot layer

rbq never syncs a live database and never runs migrations. The owner exports,
validates, then rbq publishes. opendata is the owner of its database, so:

1. `SqlStore.snapshot()`:
   - **SQLite:** `VACUUM INTO` a private staging file, `PRAGMA integrity_check`,
     record `schema_migrations`, row counts, SHA-256.
   - **D1:** export via the D1 export API to SQL text, or rebuild into SQLite
     in the Linux job. D1 snapshots are therefore produced Linux-side; the
     Worker is a consumer.
2. Publish as an rbq layer named `opendata`:

   ```text
   opendata/v1/chunks/sha256/<aa>/<sha256>
   opendata/v1/snapshots/<label>/<UTC stamp>-<digest12>.json
   ```

   Manifest schema `rbq.layer.snapshot.v1`, fields exactly as `SnapshotManifest`:
   `schema, layer, id, label, created_at, run_id, chunk_bytes, digest, files[],
   owner`. Chunk size 65536 (page-aligned; rbq's measured default).
   `owner` carries our validation report including
   `{"migration": {"status": "current"}}` so rbq's migration gate understands it.
3. Chunks are written `putIfAbsent` **before** the manifest; an existing chunk is
   re-hashed before reuse (rbq `put_chunk` semantics).
4. Reader (TS, used by the Worker importer) re-validates every key, path, size,
   chunk digest and whole-file digest. Manifests are untrusted input.

Linux uses `rebsync-core::layer` (`put_chunk`, `chunk_file`,
`SnapshotManifest`, `check_manifest`, `assemble`) via `rust/opendata-rbq`;
only the layer allow-list and manifest key are computed locally.

As built, a snapshot holds `tables/<table>.ndjson`, `meta.json` and (from the
Rust build) `opendata.sqlite`. Workers cannot open SQLite files, so both
runtimes import the NDJSON tables through `SqlStore`, resumably, re-applying
the privacy guard.

## 4. KV → keys that are object keys

rbq has no KV. To keep KV exchangeable without a new protocol:

- `KvKey` = rbq `ObjectKey` grammar. Namespaces are key prefixes (`cache/`,
  `ratelimit/`, `etag/`).
- KV is **never the system of record**; only caches and hints live there. So
  KV is not synced by default.
- When a namespace must move (e.g. source ETags to a new deployment),
  `kvExport(prefix)` writes one sorted JSONL file (`{"k","v_b64","ttl"}` per
  line) and publishes it as a file in an `opendata` layer snapshot
  (`files[].path = "kv/<namespace>.jsonl"`). Import is the reverse. Same
  chunks, same manifest, same verification.

## 5. Messages and mail → immutable objects

rbq's exchange is additive objects: create-if-absent, no overwrite, no delete,
digest-verified. Messages fit that model exactly.

```text
messages/v1/<channel>/envelopes/<UTC stamp>-<sha12>.json   envelope (≤ 256 KiB)
messages/v1/<channel>/receipts/<sha12>.json                delivery receipt
```

- `channel` examples: `outbox`, `alerts`, `ops`. One rbq key segment each.
- An envelope is canonical JSON (sorted keys) of
  `{schema:"opendata.message.v1", to, from, subject, text, html?,
  attachments: [{object_key, sha256}], created_at, idempotency}`. Its key embeds
  its own digest, so a duplicate append is an identical-retry (200 in
  rbq-repository.v1, `created: false`).
- Attachments are separate objects referenced by key + sha256, so the 256 KiB
  object limit holds.
- The Mailer consumer delivers outbox envelopes that have no receipt, then
  appends the receipt. Delivery is at-least-once; receivers dedupe on
  `idempotency`.
- Because these are plain objects, `rbq repository push/pull` and rbq peer
  transports (`tcp://`, `unix://`, `unix-dgram://`) can carry messages between
  machines with no new code: an offline Linux box can queue mail that a
  connected peer sends.

Wire-level "messages" in rbq's own sense (`rbq-peer/1` frames: `status`,
`list`, `get`, `put`) are a transport, not application messages; we don't
reuse the frame format, only ride on it.

## 6. Serving rbq: `/api/rbq/{id}`

M7 adds a server implementing `ragbaz.rbq-repository.v1` on Hono, so the real
CLI works against opendata:

| Route | Behaviour |
|---|---|
| `GET /api/rbq/{id}` | describe: `{schema, repository_id, private: true, endpoint, capabilities, limits}` |
| `GET /api/rbq/{id}/objects?prefix&after&limit` | `{objects:[{key, sha256, size_bytes, created_at}], next_after}` |
| `GET /api/rbq/{id}/objects/{key}` | bytes + `x-content-sha256` |
| `PUT /api/rbq/{id}/objects/{key}` | immutable append; 201 created, 200 identical retry, 409 conflict, 413 > 256 KiB |

Errors 401/403/404/409/413/429 as in the contract. The server's tests use the
contract's `vectors` block, as Dash's server does.

## 7. Required upstream change in rebsync

`layer::LAYERS` is a hard-coded `["mneme","frog","agenda","git"]`, and
`peer.rs`, `repository_sync.rs` and `serve.rs` refuse keys outside those
prefixes. So **opendata layers can't be pushed or pulled with rbq today.**
Options, in order of preference:

1. **Registered layers**: a config section `[[layers.extra]] name = "opendata"
   prefixes = ["opendata/v1/", "messages/v1/"]` validated with the same
   label/key rules, opt-in per peer. Keeps rbq's allow-list safety while
   letting other RAGBAZ components participate.
2. Add `opendata` (and `messages`) to the constant. Simple, but couples rbq to
   this project.
3. Use only `rbq repository append/read` (works today, no layer semantics, 256 KiB
   per object).

Proposed: implement option 3 first (it unblocks M7 without touching rbq),
open an issue/PR in rebsync for option 1.

**Status (M7):** option 3 works today: the real `rbq repository
append/read/list` against `/api/rbq/{id}` is tested, and so are `push`/`pull`
of an rbq-named layer. `rust/opendata-rbq` publishes `opendata` snapshots
with rebsync-core's own chunking and types; for rbq's own layers its output is
accepted by rebsync-core's `layer::load`, `assemble` and `fsck`. Option 1 is
still needed before `rbq` itself can push or pull the `opendata` layer.

## 8. Things we intentionally do not copy

- rbq's synchronous API: Workers need async; semantics are preserved instead.
- restic integration: encrypted backup stays rbq's job. A Linux deployment can
  list the opendata object root in rbq's `backup.datasets`.
- Deletion propagation: none, same as rbq. Pruning old snapshots is an admin
  action with a retention policy, mirroring `layer::prune`.
