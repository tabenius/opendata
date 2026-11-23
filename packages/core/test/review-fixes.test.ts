import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { migrate } from "@opendata/adapters-sql";
import { FIXTURE_CENTER, MAX_NEAR_CANDIDATES, Queries, Repository, cellOf, exportTables, fixtureDataset, importSnapshot, migrations, withLuhn } from "../src";

describe("workplacesNear with more candidates than the cap", () => {
  it("keeps the nearest workplaces when the cells hold more than the cap", async () => {
    expect(MAX_NEAR_CANDIDATES).toBeLessThan(5100);
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    const orgnr = withLuhn("556677883");
    await new Repository(sql).upsertOrganisations([{ orgnr, name: "Tät AB", jurform: "49", source: "fixture", sourceDate: "2026-11-23" }]);
    // Many workplaces ~1.5 km away with low cfar numbers, inserted first...
    const far = Array.from({ length: 5100 }, (_, i) => {
      // South of the centre: lower cell numbers, so an unordered index scan returns them first.
      const p = { lat: FIXTURE_CENTER.lat - 0.0135, lon: FIXTURE_CENTER.lon + (i % 50) * 0.00001 };
      return { sql: "INSERT INTO workplace (cfar, orgnr, lat, lon, cell, source_date) VALUES (?, ?, ?, ?, ?, 'd')", params: [i + 1, orgnr, p.lat, p.lon, cellOf(p)] };
    });
    for (let i = 0; i < far.length; i += 500) await sql.batch(far.slice(i, i + 500));
    // ...and one exactly at the centre, inserted last.
    await sql.exec("INSERT INTO workplace (cfar, orgnr, lat, lon, cell, source_date) VALUES (99999999, ?, ?, ?, ?, 'd')", [orgnr, FIXTURE_CENTER.lat, FIXTURE_CENTER.lon, cellOf(FIXTURE_CENTER)]);
    const near = await new Queries(sql).workplacesNear({ point: FIXTURE_CENTER, radiusM: 2000, first: 1 });
    expect(near.items[0]?.cfar).toBe(99999999);
    expect(near.items[0]?.distanceM).toBe(0);
  });
});

describe("snapshot import lease", () => {
  async function setup() {
    const src = new SqliteSqlStore(":memory:");
    await migrate(src, migrations);
    const repo = new Repository(src);
    const d = fixtureDataset();
    await repo.upsertAddresses(d.addresses);
    await repo.upsertOrganisations(d.organisations);
    await repo.upsertWorkplaces(d.workplaces);
    const { publishSnapshot, sha256Hex } = await import("@opendata/rbq");
    const objects = new MemoryObjectStore();
    const outcome = await publishSnapshot(objects, { layer: "opendata", label: "l", files: await exportTables(src), owner: {} });
    const { loadManifest } = await import("@opendata/rbq");
    const manifest = await loadManifest(objects, "opendata", outcome.id);
    const dest = new SqliteSqlStore(":memory:");
    await migrate(dest, migrations);
    return { dest, objects, manifest, sha256Hex };
  }

  it("lets only one of two overlapping imports run", async () => {
    const { dest, objects, manifest, sha256Hex } = await setup();
    const results = await Promise.allSettled([
      importSnapshot(dest, objects, manifest, { sha256Hex }),
      importSnapshot(dest, objects, manifest, { sha256Hex }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as { kind?: string }).kind === "Unavailable")).toHaveLength(1);
  });

  it("takes an expired lease and never releases someone else's", async () => {
    const { dest, objects, manifest, sha256Hex } = await setup();
    await dest.exec("INSERT INTO dataset_meta (key, value, updated_at) VALUES ('import_lease', ?, 'x')", [`${Date.now() + 60000}|someone-else`]);
    await expect(importSnapshot(dest, objects, manifest, { sha256Hex })).rejects.toMatchObject({ kind: "Unavailable" });
    expect((await dest.first<{ value: string }>("SELECT value FROM dataset_meta WHERE key = 'import_lease'"))?.value).toMatch(/someone-else$/);
    await dest.exec("UPDATE dataset_meta SET value = ? WHERE key = 'import_lease'", [`${Date.now() - 1}|someone-else`]);
    expect((await importSnapshot(dest, objects, manifest, { sha256Hex })).done).toBe(true);
    expect(await dest.first("SELECT value FROM dataset_meta WHERE key = 'import_lease'")).toBeNull();
  });
});
