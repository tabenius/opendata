import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { MemoryKvStore } from "@opendata/adapters-kv";
import { parseObjectKey } from "@opendata/ports";
import { FIXTURE_CENTER, Repository, fixtureDataset, migrations } from "@opendata/core";
import { createApi } from "../src";

export async function fixtureApi() {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  const repo = new Repository(sql);
  const data = fixtureDataset();
  await repo.upsertAddresses(data.addresses);
  await repo.upsertOrganisations(data.organisations);
  await repo.upsertWorkplaces(data.workplaces);
  await repo.upsertAreas(data.areas);
  await repo.upsertAreaStats(data.stats);
  const objects = new MemoryObjectStore();
  const app = createApi({ sql, objects, kv: new MemoryKvStore(), config: { publicUrl: "http://localhost", rateLimitPerMinute: 1000 } });
  return { app, data, objects, repo };
}

async function gql(app: Awaited<ReturnType<typeof fixtureApi>>["app"], query: string, variables?: unknown) {
  const res = await app.request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  return (await res.json()) as { data?: any; errors?: { message: string }[] };
}

describe("GraphQL API", () => {
  it("serves organisations with workplaces and sources", async () => {
    const { app, data } = await fixtureApi();
    const r = await gql(app, `query($o: ID!) { organisation(orgnr: $o) { name orgnrFormatted sources { attribution } workplaces { items { name location { lat } } } } }`, { o: data.organisations[1]!.orgnr });
    expect(r.errors).toBeUndefined();
    expect(r.data.organisation.name).toBe("Bryggeri Väst AB");
    expect(r.data.organisation.workplaces.items).toHaveLength(2);
    expect(r.data.organisation.sources[0].attribution).toMatch(/Fiktiva/);
  });

  it("finds workplaces near a point and never returns natural persons", async () => {
    const { app, data } = await fixtureApi();
    const r = await gql(app, `query($p: PointInput) { workplacesNear(point: $p, radiusM: 3000, first: 100) { items { orgnr distanceM organisation { name } } totalEstimate attribution } }`, { p: FIXTURE_CENTER });
    expect(r.errors).toBeUndefined();
    expect(r.data.workplacesNear.items.length).toBe(12);
    expect(r.data.workplacesNear.items.map((w: { orgnr: string }) => w.orgnr)).not.toContain(data.naturalPersonIds[0]);
    expect(r.data.workplacesNear.attribution.join(" ")).toMatch(/Lantmäteriet/);
  });

  it("returns user errors for bad input and null for personnummer lookups", async () => {
    const { app, data } = await fixtureApi();
    const bad = await gql(app, `{ workplacesNear(point: {lat: 48.8, lon: 2.3}) { items { cfar } } }`);
    expect(bad.errors?.[0]?.message).toMatch(/Sweden/);
    const person = await gql(app, `query($o: ID!) { organisation(orgnr: $o) { name } }`, { o: data.naturalPersonIds[0] });
    expect(person.data.organisation).toBeNull();
  });

  it("enforces depth and field limits", async () => {
    const { app } = await fixtureApi();
    const deep = await gql(app, `{ organisations { items { workplaces { items { organisation { workplaces { items { organisation { workplaces { items { organisation { name } } } } } } } } } } } }`);
    expect(deep.errors?.[0]?.message).toMatch(/deeper/);
    const wide = await gql(app, `{ ${Array.from({ length: 301 }, (_, i) => `a${i}: sources { id }`).join(" ")} }`);
    expect(wide.errors?.[0]?.message).toMatch(/more than 300/);
  });

  it("serves only whitelisted stored files", async () => {
    const { app, objects } = await fixtureApi();
    await objects.put(parseObjectKey("annual-reports/5560360793/doc.zip"), "PK");
    expect((await app.request("/files/annual-reports/5560360793/doc.zip")).status).toBe(200);
    expect((await app.request("/files/opendata/v1/snapshots/x.json")).status).toBe(404);
    expect((await app.request("/files/annual-reports/../x")).status).toBe(404);
  });

  it("rate limits per client", async () => {
    const { data } = await fixtureApi();
    void data;
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    const app = createApi({ sql, objects: new MemoryObjectStore(), kv: new MemoryKvStore(), config: { publicUrl: "x", rateLimitPerMinute: 2 } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.request("/graphql?query={sources{id}}", { headers: { "cf-connecting-ip": "1.2.3.4" } })).status);
    expect(codes).toEqual([200, 200, 429]);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("organisation workplaces connection", () => {
  it("carries attribution like workplacesNear", async () => {
    const { app, data } = await fixtureApi();
    const r = await gql(app, `query($o: ID!) { organisation(orgnr: $o) { name workplaces { attribution items { name } } } }`, { o: data.organisations[0]!.orgnr });
    expect(r.errors).toBeUndefined();
    expect(r.data.organisation.workplaces.attribution.join(" ")).toMatch(/SCB/);
  });
});
