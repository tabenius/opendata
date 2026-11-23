# opendata — plan

Status: **M0–M7 implemented** (2026-11-23). See §16 for what was built, what
changed from this plan, and what still needs checking against live services.
Companion: [RBQ-COMPAT.md](RBQ-COMPAT.md) maps every storage layer here to the
rbq (tabenius/rebsync @ `8023dcb`) contracts it must stay compatible with.

## 1. What this is

A TypeScript service that turns Swedish **open government data** about
organisations, workplaces, addresses and areas into one queryable API. It has
three faces: a GraphQL API, an MCP server and a PWA. It runs either on
Cloudflare Workers or as a plain Linux service, from the same code, behind
virtual storage layers.

### Sources (all free at source)

| Source | Content | Access | Licence |
|---|---|---|---|
| SCB Företagsregistret API | All companies and workplaces (arbetsställen): name, legal form, SNI, addresses, size class | Free since June 2025; API key (`X-API-Key`) from SCB; a new API version was announced for Sept 2026 | Open |
| Bolagsverket "Värdefulla datamängder" | Basic company data, SNI 2025, digitally filed annual reports since 2020 | Free API (OAuth client from portal.api.bolagsverket.se) + weekly bulk zip | Open (HVD) |
| Lantmäteriet belägenhetsadresser | 3.7 M location addresses with coordinates | HVD download/API after an approved purpose application | CC BY 4.0 + conditions for data containing personal data |
| Lantmäteriet open products | Topography, place names, etc. | Account, free | CC0 |
| SCB Statistikdatabasen (PxWeb API) | Area statistics, incl. DeSO/RegSO | Free, 10 calls / 10 s / IP | CC0 |
| SCB open geodata | DeSO/RegSO boundaries, agency offices | Free download | CC0 |

Verify each source's current endpoint and terms at implementation time; the
SCB API in particular is mid-version-change.

### Non-goals (deliberate)

- **No natural-person lookup.** No SPAR, no folkbokföring, no "who lives at or
  near this address". Swedish law restricts that by design (SPAR may search by
  address only together with a name) and personal data is never released as
  open data. This project does not rebuild Ratsit/Eniro.
- **Sole traders are people.** An *enskild näringsidkare* in Företagsregistret
  is a natural person, identified by personnummer and often registered at
  home. Policy (changed during M1, see §16): they are **dropped at ingest**
  and never stored, exported or looked up. See doc/PRIVACY.md.
- No credit data, no payment remarks, no income data.
- Lantmäteriet addresses are used as **places** (geocoding, "what is near this
  point"), never joined to residents.

## 2. Shape of the system

```text
                       ┌──────────── apps ────────────┐
                       │  pwa      api       mcp      │
                       │ (Vite)  (GraphQL) (MCP SDK)  │
                       └──────────────┬───────────────┘
                                      │ uses
                       ┌──────────────▼───────────────┐
                       │ core: domain, queries,       │
                       │ privacy policy, source       │
                       │ connectors, ingest pipeline  │
                       └──────────────┬───────────────┘
                                      │ depends only on ports
     ┌───────────────┬────────────────┼────────────────┬───────────────┐
     ▼               ▼                ▼                ▼               ▼
  ObjectStore     SqlStore         KvStore          Mailer          Clock/Log
  r2 · s3 · fs   d1 · sqlite     cf-kv · redis/    cf-email ·
  · memory       · memory        valkey · sqlite   resend · smtp
                                  · memory          · memory
     └───────────────┴────── runtime composition ─────┴───────────────┘
            workers/entry.ts (bindings)    linux/entry.ts (config + env)
```

The rule: **core and apps import only `@opendata/ports`**. Adapters are wired
in exactly two composition roots, one per runtime. A test runtime wires the
memory adapters.

## 3. Repository layout

pnpm workspaces + Turborepo (same toolchain as font-ui), Cargo workspace beside it.

```text
opendata/
├─ doc/                         plans, ADRs, conformance notes
├─ contracts/
│  └─ rbq/                      vendored rbq-repository.v1.json + SHA256SUMS
├─ packages/
│  ├─ ports/                    interfaces, errors, capabilities (no deps)
│  ├─ rbq/                      TS port of rbq contract: keys, digests,
│  │                            manifests, chunking, rbq-repository.v1 client+server
│  ├─ adapters-object/          r2, s3 (aws4fetch), fs (node), memory
│  ├─ adapters-sql/             d1, sqlite (node:sqlite / better-sqlite3), memory
│  ├─ adapters-kv/              cf-kv, redis (Valkey/Redis protocol), sqlite, memory
│  ├─ adapters-mail/            cf-email, resend, smtp (linux only), memory
│  ├─ conformance/              shared test suites every adapter must pass
│  ├─ core/                     domain model, queries, privacy policy
│  ├─ sources/                  scb-fr, bolagsverket-hvd, lantmateriet, scb-px
│  └─ schema/                   SQL migrations, GraphQL SDL, MCP tool schemas
├─ apps/
│  ├─ api/                      Hono + GraphQL Yoga (Workers + Node)
│  ├─ mcp/                      MCP server: Streamable HTTP + stdio
│  ├─ pwa/                      Vite + MapLibre, offline-first
│  ├─ worker/                   Cloudflare entry, wrangler.toml
│  └─ linux/                    Node entry, systemd unit, config loader
└─ rust/
   ├─ Cargo.toml                workspace
   ├─ opendata-ingest/          bulk parse, normalise, geocode, build SQLite
   ├─ opendata-rbq/             publish/pull snapshots via rebsync-core
   └─ opendata-geo/             SWEREF99 TM ↔ WGS84, cell index (also → wasm)
```

## 4. Runtime targets

| Concern | Cloudflare Workers | Linux |
|---|---|---|
| HTTP | Hono on `fetch` | Hono on `@hono/node-server` (or Bun) |
| Files | R2 binding | fs (rbq store layout) or any S3 (MinIO, Garage, R2 over S3 API) |
| SQL | D1 | SQLite (WAL) |
| KV | Workers KV | Valkey/Redis; SQLite KV for zero-dependency installs |
| Mail | CF Email binding, Resend | SMTP, Resend |
| Jobs | Cron Triggers, Queues, Workflows | systemd timers, in-process queue |
| Heavy ingest | **not here** (CPU/memory limits) | Rust `opendata-ingest` |
| Secrets | Wrangler secrets | owner-only files (`chmod 600`), as rbq requires |

Ingest is deliberately Linux-side. Bolagsverket's bulk zip and a full SCB pull
don't fit Workers' CPU budget. The Linux job builds a SQLite database, publishes
it as an rbq snapshot to R2, and the Worker imports it into D1 (§7). The
same snapshot can be pulled with `rbq repository pull` to any peer.

Cloudflare Containers is a possible later home for the ingest job; not
assumed.

## 5. Ports (the virtual layers)

All ports are async (Workers have no sync I/O). Semantics, names and error
taxonomy follow rbq's synchronous Rust `ObjectStorage` trait, so code reads
the same on both sides. Full mapping in RBQ-COMPAT.md.

### 5.1 ObjectStore (files)

```ts
interface ObjectStore {
  capabilities(): StorageCapabilities;            // rbq field names
  put(key: ObjectKey, data: Bytes): Promise<ObjectMeta>;
  putIfAbsent(key: ObjectKey, data: Bytes): Promise<PutOutcome>;
  get(key: ObjectKey): Promise<Uint8Array>;
  getStream(key: ObjectKey): Promise<ReadableStream<Uint8Array>>;
  getRange(key: ObjectKey, range: { start: number; end: number }): Promise<Uint8Array>;
  head(key: ObjectKey): Promise<ObjectMeta>;
  listPrefix(prefix: string, opts?: { after?: string; limit?: number }): Promise<ListPage>;
  delete(key: ObjectKey): Promise<void>;          // admin only, never synced
}
```

- `ObjectKey` is a branded string validated by the **rbq key grammar**:
  `[A-Za-z0-9._-]` segments, `/` separator, ≤1024 bytes, ≤255 per segment,
  no `.`/`..`/empty segments.
- `putIfAbsent` on R2 uses `onlyIf: { etagDoesNotMatch: "*" }`, on S3
  `If-None-Match: *`, on fs a hard-link publish (same as rbq). Adapters report
  `atomicCreateIfAbsent` truthfully.
- `listPrefix` is a **raw string prefix**, sorted, paged with `after`.
  It is not a directory listing.
- `getStream` exists in addition to rbq's buffered calls because Workers have
  128 MB memory.

### 5.2 SqlStore

```ts
interface SqlStore {
  capabilities(): SqlCapabilities;   // dialect "sqlite", maxBoundParams, batchAtomic, …
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  exec(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  batch(statements: Statement[]): Promise<BatchResult>;   // atomic in both D1 and SQLite
  migrate(migrations: Migration[]): Promise<MigrationReport>;
  snapshot(into: SnapshotSink): Promise<SqlSnapshot>;     // see RBQ-COMPAT §3
}
```

- One dialect only: **SQLite**, which is what D1 is. No ORM. Kysely is
  optional as a typed query builder over this port (it has D1 and SQLite
  dialects); the port stays raw.
- No interactive transactions: D1 doesn't offer them. Use `batch` everywhere,
  so both backends behave alike.
- Migrations are owned by this project, numbered, checksummed, recorded in a
  `schema_migrations` table. rbq never runs them (rbq's own rule).
- No SpatiaLite (absent on D1). Spatial queries use a cell index (§6).

### 5.3 KvStore

```ts
interface KvStore {
  capabilities(): KvCapabilities;  // consistency: "eventual"|"strong", minTtlSeconds, maxValueBytes
  get(key: KvKey): Promise<Uint8Array | null>;
  getJson<T>(key: KvKey): Promise<T | null>;
  put(key: KvKey, value: Bytes | Json, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: KvKey): Promise<void>;
  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<KvPage>;
}
```

- Lowest common denominator is Workers KV: eventual consistency, last write
  wins, minimum TTL 60 s, no compare-and-swap. The port promises **only
  that**. Anything needing atomicity goes to SQL or to `putIfAbsent` objects.
- `KvKey` uses the rbq key grammar too, so any KV namespace can be exported
  as objects without escaping.
- Linux default: **Valkey** (BSD, Redis-protocol). Redis works with the same
  adapter (check its current licence fits your deployment). SQLite-backed KV
  is for single-process and dev setups.
- Uses: API response cache, rate-limit buckets (approximate), source ETags,
  PWA tile/metadata cache keys. Never the system of record.

### 5.4 Mailer (mail and messages)

```ts
interface Mailer {
  capabilities(): MailCapabilities;   // arbitraryRecipients, attachments, maxBytes
  send(message: OutboundMessage): Promise<SendReceipt>;
}
interface MessageLog {               // transport-independent, rbq-shaped
  append(channel: Channel, message: Envelope): Promise<MessageRef>;  // immutable object
  list(channel: Channel, after?: string): Promise<MessageRef[]>;
  read(ref: MessageRef): Promise<Envelope>;
}
```

- Adapters:
  - `cf-email`: the Workers `send_email` binding. Historically it only reaches
    verified destination addresses; Cloudflare's newer Email Service lifts that
    where enabled. Verify before relying on it.
  - `resend`: works on both runtimes over `fetch`.
  - `smtp`: Linux only (nodemailer). Workers' outbound port 25 is blocked, and
    TCP-socket SMTP from a Worker isn't worth it.
- **Outbox pattern.** `send` never fires directly from a request handler. The
  handler appends an envelope to `MessageLog` (`messages/v1/outbox/…`, an
  immutable rbq object); a queue/cron consumer delivers it and appends a
  receipt (`messages/v1/receipts/…`). Messages are then transceivable with rbq
  push/pull like any other layer, and retries are idempotent by content
  digest.
- Uses: subscription alerts ("new company registered in DeSO X with SNI Y"),
  magic-link sign-in for the PWA, operator reports.

### 5.5 Errors and capabilities

One error enum in all ports, the rbq taxonomy:
`InvalidKey | NotFound | AlreadyExists | PermissionDenied | Unavailable |
Corrupt | Unsupported | Backend`. HTTP mapping is rbq's: 400/404/409/403/503/
501/500. Adapters must not claim capabilities they can't demonstrate; the
conformance suite checks each claimed flag.

## 6. Data model (SQLite / D1)

```text
organisation(orgnr PK, name, legal_form, is_natural_person, status,
             sni_primary, registered_at, source, source_date)
workplace(cfar PK, orgnr FK, name, sni, size_class,
          visit_street, visit_postcode, visit_town, kommun,
          address_id FK NULL, lat, lon, cell, source_date)
address(address_id PK, street, number, letter, postcode, town, kommun,
        lat, lon, cell, lm_uuid, source_date)           -- belägenhetsadress
area(deso PK, regso, kommun, name, geom_ref)            -- geometry in ObjectStore
area_stat(deso, table_id, variable, period, value, PK(deso,table_id,variable,period))
annual_report(orgnr, period_end, object_key, sha256)    -- documents in ObjectStore
sni(code PK, version, title_sv, title_en)
source_run(id PK, source, started_at, finished_at, rows, snapshot_id, status)
```

- Workplaces are **not geocoded** in SCB's API; ingest matches visit addresses
  to Lantmäteriet addresses (the same thing SCB does for its own geodata) and
  records the match quality.
- Spatial: `cell` = a fixed-resolution grid cell over SWEREF99 TM (e.g.
  250 m) or H3 r9, computed in `opendata-geo`. Proximity = the cell set covering
  a radius, then an exact haversine filter in TS. Works the same on D1 and
  SQLite with a plain B-tree index.
- `is_natural_person` drives the privacy policy in `core`, not in each
  resolver. Policy lives in one module with tests.

Size check: about 1.2 M organisations, about 1.5 M+ workplaces, 3.7 M addresses.
Order of a few GB with indexes, so it fits D1's per-database limit, but
verify the current limit, and keep `annual_report` blobs in R2, not D1.

## 7. Ingest and distribution (rbq-shaped)

```text
Linux (cron/systemd)                         Cloudflare
───────────────────                          ──────────
sources/* fetch  ─►  rust opendata-ingest
                     normalise, geocode,
                     build opendata.sqlite
                     VACUUM INTO, integrity_check
                           │
                     opendata-rbq publish
                     64 KiB page-aligned chunks
                     + rbq.layer.snapshot.v1 manifest
                           │  put_if_absent
                           ▼
                     R2 (S3 API)  ───────────►  Worker cron: read manifest,
                     opendata/v1/...            reassemble+verify, import
                                                into D1 (batched), flip
                                                "active snapshot" pointer
```

- Unchanged data re-exports byte-identically and reuses chunks (rbq's
  measured behaviour for page-aligned SQLite exports).
- Every snapshot is immutable and addressable; the active one is a single SQL
  row/KV pointer, so rollback is changing the pointer.
- A Linux deployment skips D1: it opens the verified SQLite directly
  (read-only), or pulls the snapshot from another peer with `rbq`.
- Rate limits: SCB PxWeb is capped at 10 requests / 10 s per IP. Connectors
  carry a token bucket and honour `Retry-After`.

## 8. GraphQL API

GraphQL Yoga on Hono, identical on both runtimes. Persisted queries and a
depth/cost limit from day one: graph APIs are scrape magnets.

```graphql
type Query {
  organisation(orgnr: ID!): Organisation
  organisations(filter: OrgFilter!, first: Int = 20, after: String): OrgConnection!
  workplacesNear(point: PointInput, address: String, radiusM: Int! = 500,
                 sni: [String!], first: Int = 50, after: String): WorkplaceConnection!
  geocode(address: String!): [Address!]!
  area(deso: ID, point: PointInput): Area
  sources: [SourceStatus!]!
}
```

`workplacesNear` never returns `is_natural_person` entities (§1). Pagination
is cursor-based with a hard cap on `first`, the same discipline as rbq's
`list_limit_max`.

## 9. MCP server

Built with `@modelcontextprotocol/sdk`. Streamable HTTP on Workers (stateless,
or `McpAgent` + Durable Object if sessions are needed later). stdio on Linux.
Tools are thin wrappers over the same `core` queries as GraphQL:

| Tool | Purpose |
|---|---|
| `lookup_organisation` | by orgnr; includes source + source date |
| `search_organisations` | name/SNI/kommun/legal form, paged |
| `workplaces_near` | address or point + radius, legal entities only |
| `geocode_address` | Lantmäteriet address → coordinates + DeSO |
| `area_profile` | DeSO statistics summary |
| `annual_reports` | list filed reports; returns R2 object refs |
| `source_status` | freshness and licence/attribution per source |

Every tool result carries `source`, `sourceDate` and the attribution string
CC BY requires (Lantmäteriet HVD). Auth: bearer tokens in the header only,
never in URLs, the same rule as rbq.

## 10. PWA

Vite + TypeScript, MapLibre GL with open vector tiles (or Lantmäteriet open
topography). Features:

- address search → map with nearby **companies and workplaces** (legal entities),
  SNI filter, area statistics panel;
- organisation page with annual-report links;
- saved areas and watch alerts (delivered through the Mailer outbox);
- offline: Workbox; cached query results in IndexedDB; installable.

Served from Workers static assets on Cloudflare, or from the Linux Hono server.

## 11. Rust: where it earns its place

| Crate | Why Rust | Targets |
|---|---|---|
| `opendata-ingest` | Multi-GB CSV/zip parse, address matching, deterministic SQLite build | Linux binary |
| `opendata-rbq` | Reuse `rebsync-core` (`layer`, `storage`, `repository`) instead of re-porting chunk/manifest/verify logic | Linux binary; git dependency pinned to a rebsync commit |
| `opendata-geo` | Projection + cell index; one implementation for ingest (native) and PWA/Worker (wasm) | native + `wasm32-unknown-unknown` |

The TS `packages/rbq` still implements the **read/verify** side (manifest
parse, chunk reassembly, digests) because the Worker must import snapshots and
can't call the Rust crate. Both sides run the same conformance vectors.

## 12. Configuration and secrets

- Linux: rbq-style precedence: defaults → `$XDG_CONFIG_HOME/opendata/config.toml`
  → `--config` → CLI flags. Unknown keys are errors. Secrets come from
  owner-only files (`*_file` keys), refused if group/world readable. Never in
  TOML, URLs or argv.
- Workers: `wrangler.toml` bindings (`OBJECTS` R2, `DB` D1, `CACHE` KV,
  `EMAIL` send_email) + secrets (`BOLAGSVERKET_CLIENT_SECRET`, `RESEND_API_KEY`).
- Adapter choice is config, not code: `objects = "r2" | "s3" | "fs"`,
  `kv = "cf" | "redis" | "sqlite"`, `mail = "cf" | "resend" | "smtp"`.

## 13. Testing

1. **Port conformance** (`packages/conformance`): one suite per port, run
   against every adapter. It covers key grammar vectors from the vendored rbq
   contract, create-if-absent races, raw-prefix listing order, range reads,
   KV TTL floor, batch atomicity, mail outbox idempotency.
2. **rbq interop**: publish a snapshot with TS, verify with `rbq storage fsck`;
   publish with `opendata-rbq`, import with the TS reader; serve
   `/api/rbq/{id}` and drive it with the real `rbq repository` CLI.
3. Workers: `@cloudflare/vitest-pool-workers` (Miniflare) for R2/D1/KV.
   Linux: real SQLite, Valkey in a container, MinIO for S3, Mailpit for SMTP.
4. Privacy tests: sole traders never appear in proximity, area or search
   results, whatever the query.

## 14. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M0 | Monorepo skeleton, `ports`, `rbq` contract package, vendored contract + checksums, CI | Contract vectors pass in TS |
| M1 | Memory + fs + sqlite adapters; SCB FR connector; organisation lookup over GraphQL on Linux | `organisation(orgnr)` works locally |
| M2 | R2/D1/KV adapters; Worker entry; conformance green on both runtimes | Same GraphQL query on Workers |
| M3 | Rust ingest + Lantmäteriet geocoding + rbq snapshot publish; Worker D1 import | `workplacesNear` on both runtimes |
| M4 | MCP server (HTTP + stdio) | Tools usable from Claude Desktop and Workers URL |
| M5 | Bolagsverket HVD + annual reports in ObjectStore; SCB PxWeb area stats | `area_profile`, `annual_reports` |
| M6 | Mailer adapters + outbox + watch alerts; PWA v1 | Alert e-mail for a watched DeSO |
| M7 | `/api/rbq/{id}` rbq-repository.v1 endpoint; rbq push/pull of opendata layers | `rbq repository pull` round-trip |

## 15. Open questions

1. ~~rbq layer registry~~: resolved by tabenius/rebsync#35 (RBQ-COMPAT §7).
2. Lantmäteriet HVD application: the purpose statement must say addresses are
   used as places, not linked to residents. Check whether redistribution of
   derived coordinates via the API is covered.
3. CF Email Service availability/pricing vs. Resend as the Workers default.
4. D1 database size limit vs. full dataset; split read-replica databases per
   table group if needed.
5. Auth for the public API: anonymous with tight limits, or API keys only?

## 16. Status after M0–M7

### Built

| # | Delivered | Verified by |
|---|---|---|
| M0 | pnpm/Turbo workspace, `ports`, `rbq` package (contract vendored with checksum), CI | every contract vector in TS |
| M1 | memory/fs/SQLite/Redis adapters, schema, core queries, privacy guard, SCB FR connector, GraphQL, Linux CLI | conformance suites; end-to-end HTTP |
| M2 | R2, S3, D1, Workers KV adapters, Worker entry | conformance on Miniflare (workerd) and an S3 server (moto); bundled Worker in workerd |
| M3 | Rust `opendata-geo` (+wasm), `opendata-ingest`, `opendata-rbq`; resumable snapshot import on both runtimes | shared vectors; rebsync-core's reader/fsck accept our output; TS↔Rust interop over real files; R2→D1 import in workerd |
| M4 | MCP server: 7 read-only tools, Streamable HTTP (stateless) and stdio | SDK client in-memory, over HTTP, in workerd, real stdio handshake |
| M5 | Bolagsverket client (OAuth2, organisations, annual-report zips), PxWebApi v2 (JSON-stat 2.0) | fake-server tests |
| M6 | Mailers (Resend, Workers send_email/MIME, SMTP), rbq-shaped outbox, double opt-in watches, PWA | SMTP test server; PWA screenshots in headless Chrome |
| M7 | `/api/rbq/{id}` rbq-repository.v1 server | the real `rbq` CLI: describe, append, list, read, push, pull |

### Changed from the plan

- **Privacy:** natural persons are excluded at ingest instead of hidden at
  query time. In a sample municipality about a third of workplaces belonged
  to natural persons, identified by personnummer; storing them would have put
  personal data into the database, snapshots and backups.
- **Snapshots** carry `tables/*.ndjson` + `meta.json` (and `opendata.sqlite`
  from the Rust build). Workers cannot open SQLite files, so one NDJSON import
  path serves D1 and SQLite alike; rows carry a `snapshot` column and rows from
  older snapshots are deleted when an import completes.
- **Area geometry** lives in `area.geometry` (SQL), not as separate objects.
- **Messages** use `messages/v1/<channel>/envelopes/…` and
  `…/receipts/…` so listing envelopes never returns receipts.
- **rbq layers:** rebsync now registers `opendata` as an external layer
  (tabenius/rebsync#35); `opendata-rbq` calls rebsync-core's publisher and
  readers directly, and the real rbq CLI pushes and pulls `--layer opendata`.
  The mail outbox is deliberately not a layer (RBQ-COMPAT §5, §7).
- **Spatial index** is a 0.01° grid (`cell`), not H3.
- **Persisted GraphQL queries** were not added; depth (8) and field (300)
  limits, body size cap and per-client rate limiting were.

### Still to check against live services

These were written from documentation and public client code, without
credentials, and are covered by fake-server tests only:

1. Bolagsverket response field paths, token URL/scope, test-environment URLs.
2. SCB FR legal-unit fields beyond identity/jurform/name, and the
   September 2026 API version.
3. Lantmäteriet's actual address column names (mapping is configurable).
4. PxWeb table ids and dimension codes for the DeSO statistics you want.
5. Workers `send_email` behaviour for non-verified recipients.
6. D1 size and import limits for a national dataset.
