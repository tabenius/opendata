/**
 * Runs the real bundled Worker in workerd (Miniflare) with R2, D1 and KV
 * bindings, seeds D1 through the same Repository code, and queries GraphQL.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { D1SqlStore, migrate, type D1DatabaseLike } from "@opendata/adapters-sql";
import { FIXTURE_CENTER, Repository, fixtureDataset, migrations } from "@opendata/core";

const dir = fileURLToPath(new URL("..", import.meta.url));
let mf: Miniflare;

export async function startWorker(extra: Record<string, unknown> = {}) {
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", "dist"], { cwd: dir, stdio: "pipe" });
  const instance = new Miniflare({
    modules: true,
    scriptPath: `${dir}dist/index.js`,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2025-09-01",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["OBJECTS"],
    d1Databases: ["DB"],
    kvNamespaces: ["CACHE"],
    bindings: { PUBLIC_URL: "http://worker.test", RATE_LIMIT_PER_MINUTE: "1000", SNAPSHOT_LABEL: "local", ...extra },
  });
  const sql = new D1SqlStore((await instance.getD1Database("DB")) as unknown as D1DatabaseLike);
  await migrate(sql, migrations);
  return { instance, sql };
}

beforeAll(async () => {
  const started = await startWorker();
  mf = started.instance;
  const repo = new Repository(started.sql);
  const d = fixtureDataset();
  await repo.upsertAddresses(d.addresses);
  await repo.upsertOrganisations(d.organisations);
  await repo.upsertWorkplaces(d.workplaces);
  await repo.upsertAreas(d.areas);
  await repo.upsertAreaStats(d.stats);
}, 60000);

afterAll(async () => mf?.dispose());

describe("Cloudflare Worker (workerd)", () => {
  it("answers health with D1, R2 and KV adapters", async () => {
    const res = await mf.dispatchFetch("http://worker.test/healthz");
    expect(await res.json()).toMatchObject({ ok: true, objects: "r2", sql: "d1", kv: "cf-kv" });
  });

  it("serves the same GraphQL queries as Linux", async () => {
    const res = await mf.dispatchFetch("http://worker.test/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query($p: PointInput) { workplacesNear(point: $p, radiusM: 3000, first: 100) { totalEstimate items { name } } organisations(filter: {query: "kod"}) { items { name } } }`, variables: { p: FIXTURE_CENTER } }),
    });
    const body = (await res.json()) as { data: any; errors?: unknown };
    expect(body.errors).toBeUndefined();
    expect(body.data.workplacesNear.totalEstimate).toBe(12);
    expect(body.data.organisations.items[0].name).toBe("Kodverkstaden AB");
  });
});

describe("Worker snapshot import", () => {
  it("imports a published snapshot from R2 into D1 across cron ticks", async () => {
    const { R2ObjectStore } = await import("@opendata/adapters-object");
    const { SqliteSqlStore } = await import("@opendata/adapters-sql/sqlite");
    const { publishDatabase } = await import("@opendata/datasets");
    const { instance, sql } = await startWorker({ ADMIN_TOKEN: "admin-secret", IMPORT_ROWS_PER_TICK: "10", SNAPSHOT_LABEL: "national" });
    try {
      // Build a snapshot on "Linux" (SQLite) and publish it straight into the Worker's R2 bucket.
      const src = new SqliteSqlStore(":memory:");
      await migrate(src, migrations);
      const repo = new Repository(src);
      const d = fixtureDataset();
      await repo.upsertAddresses(d.addresses);
      await repo.upsertOrganisations(d.organisations);
      await repo.upsertWorkplaces(d.workplaces);
      const bucket = (await instance.getR2Bucket("OBJECTS")) as never;
      const published = await publishDatabase(src, new R2ObjectStore(bucket), "national");
      expect((await instance.dispatchFetch("http://worker.test/admin/import", { method: "POST" })).status).toBe(401);
      let active: string | null = null;
      for (let i = 0; i < 20 && active !== published.id; i++) {
        const res = await instance.dispatchFetch("http://worker.test/admin/import", { method: "POST", headers: { Authorization: "Bearer admin-secret" } });
        active = ((await res.json()) as { active: string | null }).active;
      }
      expect(active).toBe(published.id);
      expect(await sql.first("SELECT count(*) AS c FROM workplace")).toEqual({ c: 12 });
      const health = (await (await instance.dispatchFetch("http://worker.test/healthz")).json()) as { snapshot: string };
      expect(health.snapshot).toBe(published.id);
    } finally {
      await instance.dispose();
    }
  }, 60000);
});

describe("Worker MCP endpoint", () => {
  it("answers MCP tool calls over Streamable HTTP in workerd", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await mf.dispatchFetch(String(input), init as never);
      return new Response(res.body as never, { status: res.status, headers: res.headers as never });
    }) as typeof fetch;
    const client = new Client({ name: "worker-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://worker.test/mcp"), { fetch: fetcher }));
    const r = (await client.callTool({ name: "workplaces_near", arguments: { lat: FIXTURE_CENTER.lat, lon: FIXTURE_CENTER.lon, radiusM: 3000, first: 100 } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text).result.items).toHaveLength(12);
    await client.close();
  });
});

describe("Worker watches and mail", () => {
  it("creates a watch over GraphQL and queues the confirmation in the R2 outbox", async () => {
    const { instance } = await startWorker({ ADMIN_TOKEN: "a", RESEND_API_KEY: "re_test", MAIL_FROM: "alerts@od.example" });
    try {
      const res = await instance.dispatchFetch("http://worker.test/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `mutation { watchArea(email: "me@example.se", kommun: "1480") { accepted message } }` }),
      });
      expect(((await res.json()) as any).data.watchArea.accepted).toBe(true);
      const bucket = await instance.getR2Bucket("OBJECTS");
      const listed = await bucket.list({ prefix: "messages/v1/outbox/envelopes/" });
      expect(listed.objects).toHaveLength(1);
    } finally {
      await instance.dispose();
    }
  }, 60000);
});
