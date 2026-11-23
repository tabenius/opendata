# Deployment

## Cloudflare Workers

Bindings (see `apps/worker/wrangler.toml`): R2 `OBJECTS`, D1 `DB`, Workers KV
`CACHE`, optional `send_email` `EMAIL`, static assets from `apps/pwa/dist`.

```sh
pnpm install
pnpm --filter @opendata/pwa build
cd apps/worker
npx wrangler r2 bucket create opendata
npx wrangler d1 create opendata            # put database_id in wrangler.toml
npx wrangler kv namespace create CACHE     # put id in wrangler.toml
npx wrangler secret put ADMIN_TOKEN        # for POST /admin/import and /admin/mail
npx wrangler secret put MCP_TOKEN          # optional: require a bearer token on /mcp
npx wrangler secret put RESEND_API_KEY     # optional: mail via Resend
npx wrangler deploy
```

Migrations run on the first request of each isolate (checksummed,
idempotent).

**Data.** Publish a snapshot into the R2 bucket (see doc/DATA.md) under the
label in `SNAPSHOT_LABEL`. The cron (every 15 min) imports
`IMPORT_ROWS_PER_TICK` rows (default 20 000) per tick, resuming where it
stopped, then removes rows from older snapshots and flips
`active_snapshot`. `POST /admin/import` with `Authorization: Bearer
$ADMIN_TOKEN` runs a tick on demand.

For a national dataset (several million rows) the cron path is slow and
costly. Load the first full dataset with D1's own import instead: dump the
data tables of the Rust-built SQLite to SQL and run `wrangler d1 execute
opendata --remote --file dump.sql`. Check D1's current import limits first;
virtual tables such as the FTS5 indexes may need rebuilding after the import
(`INSERT INTO organisation_fts (orgnr, name) SELECT orgnr, name FROM
organisation`, and likewise for `address_fts`). Publish later updates as
snapshots.

**Mail.** `RESEND_API_KEY` sends to anyone. Without it, the `send_email`
binding is used, which delivers only to verified destination addresses
(fine for operator reports, not for public watches). Set `MAIL_FROM`.

**Limits.** The in-process rate limiter is per isolate. Add Cloudflare rate
limiting rules on `/graphql` and `/mcp` for hard limits.

## Linux

Requirements: Node 22.13+ (built-in `node:sqlite`), pnpm; Rust for the bulk
tools; optional Valkey/Redis, an S3 service, an SMTP server.

```sh
sudo useradd --system --home /var/lib/opendata opendata
sudo install -d -o opendata -m 700 /var/lib/opendata
sudo install -d -m 750 -g opendata /etc/opendata
sudo cp deploy/opendata.example.toml /etc/opendata/config.toml   # edit
# Secrets: one per file, owner-only, e.g.
sudo install -m 600 -o opendata /dev/null /etc/opendata/scb-api-key
git clone https://github.com/tabenius/opendata /opt/opendata && cd /opt/opendata
pnpm install --prod=false && pnpm --filter @opendata/pwa build
(cd rust && cargo build --release)    # opendata-ingest, opendata-rbq
sudo cp deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opendata.service opendata-jobs.timer
```

Put a TLS reverse proxy (Caddy, nginx) in front. It must set
`X-Real-IP` for per-client rate limiting.

`opendata config explain --config /etc/opendata/config.toml` prints the
effective configuration with secrets redacted.

### Backups

`objects/` is an rbq object store: list it in rbq's `backup.datasets`, or push
the `opendata/` layer to a peer. `opendata.sqlite` can always be rebuilt from
the newest snapshot (`opendata snapshot import`).

## rbq repositories

`/api/rbq/<id>` speaks `ragbaz.rbq-repository.v1`. Create an id and token with
`opendata rbq token`, store the token in an owner-only file, and add a
`[[rbq.repositories]]` entry (Linux) or the `RBQ_REPOSITORIES` secret
(Workers). Then, from any machine:

```sh
rbq repository --endpoint https://opendata.example.se/api/rbq/<id> --token-file ~/.config/rbq/opendata-token describe
# Share a dataset: push the opendata layer from a local rbq store, pull it on another machine.
rbq repository ... push --store /var/lib/opendata/objects --source-id national --source-name "opendata national" --layer opendata
rbq repository ... pull --store ~/rbq-objects --source-id national --layer opendata
```

The `--layer opendata` option needs an rbq that includes tabenius/rebsync#35.
Tokens from `opendata rbq token` are `rbs_` (scoped sync) credentials.
