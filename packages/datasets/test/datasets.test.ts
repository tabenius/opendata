import { describe, expect, it } from "vitest";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { FIXTURE_CENTER, Queries, Repository, fixtureDataset, migrations } from "@opendata/core";
import { fsckLayer, loadManifest, parseObjectKey } from "@opendata/rbq";
import { latestSnapshot, publishDatabase, syncLatest } from "../src";

async function source() {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  const repo = new Repository(sql);
  const d = fixtureDataset();
  await repo.upsertAddresses(d.addresses);
  await repo.upsertOrganisations(d.organisations);
  await repo.upsertWorkplaces(d.workplaces);
  await repo.upsertAreas(d.areas);
  await repo.upsertAreaStats(d.stats);
  return { sql, repo, d };
}

async function target() {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  return sql;
}

describe("opendata snapshots over rbq", () => {
  it("publishes a database and imports it elsewhere, in budgeted steps", async () => {
    const { sql } = await source();
    const objects = new MemoryObjectStore();
    const outcome = await publishDatabase(sql, objects, "local", { chunkBytes: 4096 });
    expect((await fsckLayer(objects, "opendata")).damaged).toEqual([]);
    const dest = await target();
    let result = await syncLatest(dest, objects, "local", 7);
    let steps = 1;
    while (result.active !== outcome.id) {
      result = await syncLatest(dest, objects, "local", 7);
      steps++;
      if (steps > 100) throw new Error("no progress");
    }
    expect(steps).toBeGreaterThan(3);
    const q = new Queries(dest);
    expect((await q.workplacesNear({ point: FIXTURE_CENTER, radiusM: 3000, first: 100 })).items).toHaveLength(12);
    expect((await q.searchOrganisations({ query: "bageri" })).items).toHaveLength(1);
    expect((await q.area({ point: { lat: 57.705, lon: 11.95 } }))?.deso).toBe("1480C1010");
    expect((await syncLatest(dest, objects, "local")).state).toBeUndefined();
  });

  it("removes rows that a newer snapshot no longer has", async () => {
    const { sql, d } = await source();
    const objects = new MemoryObjectStore();
    await publishDatabase(sql, objects, "local");
    const dest = await target();
    await syncLatest(dest, objects, "local");
    await sql.exec("DELETE FROM workplace WHERE cfar = ?", [d.workplaces[0]!.cfar]);
    await new Promise((r) => setTimeout(r, 5));
    const second = await publishDatabase(sql, objects, "local");
    expect((await latestSnapshot(objects, "local"))?.id).toBe(second.id);
    const result = await syncLatest(dest, objects, "local");
    expect(result.active).toBe(second.id);
    expect(await dest.first("SELECT count(*) AS c FROM workplace")).toEqual({ c: 11 });
  });

  it("re-applies the privacy guard to snapshot rows from elsewhere", async () => {
    const { sql } = await source();
    const objects = new MemoryObjectStore();
    // A hostile peer injects a natural person into the table file.
    await sql.exec("PRAGMA foreign_keys = OFF");
    await sql.exec("INSERT INTO organisation (orgnr, name, status, sources, source_date, updated_at) VALUES ('8506121238', 'Person', 'active', 'x', 'd', 'd')");
    const outcome = await publishDatabase(sql, objects, "peer");
    const dest = await target();
    const result = await syncLatest(dest, objects, "peer");
    expect(result.state?.skipped).toBe(1);
    expect(await dest.first("SELECT 1 FROM organisation WHERE orgnr = '8506121238'")).toBeNull();
    const manifest = await loadManifest(objects, "opendata", outcome.id);
    expect(manifest.owner).toMatchObject({ migration: { status: "current" }, schema: "opendata.snapshot.v1" });
  });

  it("refuses damaged chunks", async () => {
    const { sql } = await source();
    const objects = new MemoryObjectStore();
    const outcome = await publishDatabase(sql, objects, "local");
    const manifest = await loadManifest(objects, "opendata", outcome.id);
    const chunk = manifest.files.find((f) => f.path === "tables/workplace.ndjson")!.chunks[0]!;
    await objects.put(parseObjectKey(`opendata/v1/chunks/sha256/${chunk.sha256.slice(0, 2)}/${chunk.sha256}`), "{}\n");
    await expect(syncLatest(await target(), objects, "local")).rejects.toMatchObject({ kind: "Corrupt" });
  });
});
