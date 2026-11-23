import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate, type SqlStore } from "@opendata/adapters-sql";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { MemoryKvStore } from "@opendata/adapters-kv";
import { MemoryMailer } from "@opendata/mail";
import { FIXTURE_CENTER, Repository, fixtureDataset, migrations, sniSection, sniDivisionsOf } from "@opendata/core";
import { createApi } from "../src";
import { openapi } from "../src/openapi";

/** Counts statements so batching can be asserted. */
function counting(sql: SqlStore) {
  const seen: string[] = [];
  const proxy = new Proxy(sql, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "query" || prop === "first") seen.push(String(args[0]));
        return v.apply(target, args);
      };
    },
  });
  return { sql: proxy, seen };
}

async function setup() {
  const raw = new SqliteSqlStore(":memory:");
  await migrate(raw, migrations);
  const repo = new Repository(raw);
  const d = fixtureDataset();
  await repo.upsertAddresses(d.addresses);
  await repo.upsertOrganisations(d.organisations);
  await repo.upsertWorkplaces(d.workplaces);
  await raw.exec("INSERT INTO sni (code, version, title) VALUES (?, '2007', 'Testkod')", [d.workplaces[0]!.sni!]);
  const { sql, seen } = counting(raw);
  const app = createApi({ sql, objects: new MemoryObjectStore(), kv: new MemoryKvStore(), mailer: new MemoryMailer(), config: { publicUrl: "https://od.example", mailFrom: { email: "a@od.example" }, rateLimitPerMinute: 10000 } });
  return { app, raw, seen, d };
}

describe("SNI sections", () => {
  it("maps divisions to section letters", () => {
    expect(sniSection("56100")).toEqual({ letter: "I", title: expect.stringContaining("restaurang") });
    expect(sniSection("62010")?.letter).toBe("J");
    expect(sniSection("04000")).toBeNull();
    expect(sniDivisionsOf("i")).toEqual(["55", "56"]);
  });
});

describe("GraphQL batching", () => {
  it("loads each workplace's organisation in one query, with SNI labels", async () => {
    const { app, seen, d } = await setup();
    const query = `{ workplacesNear(point: {lat: ${FIXTURE_CENTER.lat}, lon: ${FIXTURE_CENTER.lon}}, radiusM: 2000, first: 30) { items { sni sniTitle sniSection { letter } organisation { name } } } }`;
    seen.length = 0;
    const res = (await (await app.request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) })).json()) as any;
    const items = res.data.workplacesNear.items as any[];
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((w) => w.organisation?.name)).toBe(true);
    expect(items.find((w) => w.sni === d.workplaces[0]!.sni)?.sniTitle).toBe("Testkod");
    expect(items[0].sniSection.letter).toMatch(/^[A-U]$/);
    expect(seen.filter((s) => s.includes("FROM organisation WHERE orgnr IN")).length).toBe(1);
    expect(seen.filter((s) => /FROM organisation WHERE orgnr = \?/.test(s)).length).toBe(0);
  });
});

describe("REST /api/v1", () => {
  it("serves resources with attribution, problems and cursors", async () => {
    const { app, d } = await setup();
    const org = d.organisations[0]!;
    const one = await app.request(`/api/v1/organisations/${org.orgnr}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ orgnr: org.orgnr, name: org.name, sniSection: { letter: expect.any(String) } });

    const near = (await (await app.request(`/api/v1/workplaces/near?lat=${FIXTURE_CENTER.lat}&lon=${FIXTURE_CENTER.lon}&radius=2000&first=3`)).json()) as any;
    expect(near.items).toHaveLength(3);
    expect(near.attribution.length).toBeGreaterThan(0);
    const next = (await (await app.request(`/api/v1/workplaces/near?lat=${FIXTURE_CENTER.lat}&lon=${FIXTURE_CENTER.lon}&radius=2000&first=3&after=${near.nextCursor}`)).json()) as any;
    expect(next.items[0].cfar).not.toBe(near.items[0].cfar);

    const bad = await app.request(`/api/v1/organisations?kommun=14`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("application/problem+json");
    expect((await app.request(`/api/v1/organisations/5560360793`)).status).toBe(404);
    expect((await app.request(`/api/v1/workplaces/near?lat=57`)).status).toBe(400);
  });

  it("revalidates with ETags that change with the data", async () => {
    const { app, raw } = await setup();
    const url = `/api/v1/organisations?kommun=1480&first=2`;
    const first = await app.request(url);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\/"[0-9a-f]{24}"$/);
    expect(first.headers.get("cache-control")).toContain("max-age");
    expect((await app.request(url, { headers: { "If-None-Match": tag } })).status).toBe(304);
    await raw.exec("INSERT OR REPLACE INTO dataset_meta (key, value, updated_at) VALUES ('active_snapshot', 'next', '2026-11-23')");
    expect((await app.request(url, { headers: { "If-None-Match": tag } })).status).toBe(200);
  });

  it("documents every route in OpenAPI", async () => {
    const { app } = await setup();
    const doc = (await (await app.request("/api/v1/openapi.json")).json()) as typeof openapi;
    expect(doc.openapi).toBe("3.1.0");
    const routes = ["/organisations", "/organisations/{orgnr}", "/organisations/{orgnr}/workplaces", "/workplaces/near", "/geocode", "/areas", "/areas/{deso}", "/sources", "/sni/sections", "/sni/{code}"];
    expect(Object.keys(doc.paths).sort()).toEqual(routes.sort());
    // Every $ref resolves.
    const refs = JSON.stringify(doc).match(/"#\/components\/[^"]+"/g) ?? [];
    for (const ref of refs) {
      const [, , kind, name] = JSON.parse(ref).split("/");
      expect((doc.components as any)[kind][name], ref).toBeDefined();
    }
  });
});
