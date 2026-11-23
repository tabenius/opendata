import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import {
  FIXTURE_CENTER,
  Queries,
  Repository,
  cellOf,
  cellRanges,
  classify,
  fixtureDataset,
  haversineMeters,
  isLegalEntityNumber,
  migrations,
  parseOrgnr,
  parseStreetAddress,
  sweref99tmToWgs84,
  wgs84ToSweref99tm,
  withLuhn,
} from "../src";

async function loaded() {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  const repo = new Repository(sql);
  const data = fixtureDataset();
  await repo.upsertAddresses(data.addresses);
  const orgs = await repo.upsertOrganisations(data.organisations);
  const wps = await repo.upsertWorkplaces(data.workplaces);
  await repo.upsertAreas(data.areas);
  await repo.upsertAreaStats(data.stats);
  return { sql, repo, data, orgs, wps, queries: new Queries(sql) };
}

describe("identity numbers", () => {
  it("separates organisation numbers from personnummer", () => {
    expect(isLegalEntityNumber("5560360793")).toBe(true); // a real-format AB number
    expect(isLegalEntityNumber("556036-0793")).toBe(true);
    expect(isLegalEntityNumber("5560360794")).toBe(false); // bad check digit
    expect(isLegalEntityNumber(withLuhn("850612123"))).toBe(false); // personnummer shape
    expect(isLegalEntityNumber("195006121234")).toBe(false);
    expect(parseOrgnr("165560360793")).toBe("5560360793");
    expect(() => parseOrgnr(withLuhn("850612123"))).toThrow();
  });

  it("classifies by every source signal and fails closed", () => {
    expect(classify({ id: "5560360793", jurform: "49" })).toBe("legal");
    expect(classify({ id: "5560360793", jurform: "10" })).toBe("natural");
    expect(classify({ id: "5560360793", jurform: 91 })).toBe("natural");
    expect(classify({ id: "5560360793", bvForm: "E-ORGFO" })).toBe("natural");
    expect(classify({ id: "5560360793", idType: "PERSON-IDORG" })).toBe("natural");
    expect(classify({ id: withLuhn("850612123") })).toBe("natural");
    expect(classify({ id: "nonsense" })).toBe("unknown");
  });
});

describe("geodesy", () => {
  it("round-trips SWEREF 99 TM within a millimetre", () => {
    for (const p of [{ lat: 57.7072, lon: 11.9668 }, { lat: 67.85, lon: 20.22 }, { lat: 55.6, lon: 13.0 }]) {
      const back = sweref99tmToWgs84(wgs84ToSweref99tm(p));
      expect(haversineMeters(p, back)).toBeLessThan(0.001);
    }
  });

  it("puts Stockholm where SWEREF 99 TM expects it", () => {
    const { n, e } = wgs84ToSweref99tm({ lat: 59.3275, lon: 18.0545 });
    expect(n).toBeGreaterThan(6578000);
    expect(n).toBeLessThan(6582000);
    expect(e).toBeGreaterThan(672000);
    expect(e).toBeLessThan(676000);
  });

  it("covers a radius with per-row cell ranges", () => {
    const ranges = cellRanges(FIXTURE_CENTER, 1000);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(ranges.some(([a, b]) => cellOf(FIXTURE_CENTER) >= a && cellOf(FIXTURE_CENTER) <= b)).toBe(true);
    expect(() => cellRanges(FIXTURE_CENTER, 50000)).toThrow();
  });

  it("parses Swedish street addresses", () => {
    expect(parseStreetAddress("Storgatan 12 B lgh 1102")).toEqual({ street: "STORGATAN", number: "12", letter: "B" });
    expect(parseStreetAddress("Box 123")).toEqual({ street: "BOX", number: "123", letter: undefined });
    expect(parseStreetAddress("Vägen")).toEqual({ street: "VÄGEN" });
  });
});

describe("repository and queries", () => {
  it("never stores natural persons", async () => {
    const { sql, data, orgs, wps } = await loaded();
    expect(orgs.skippedNaturalPersons).toBe(2);
    expect(wps.skippedNaturalPersons).toBe(1);
    for (const id of data.naturalPersonIds) {
      expect(await sql.first("SELECT 1 FROM organisation WHERE orgnr = ?", [id])).toBeNull();
      expect(await sql.first("SELECT 1 FROM workplace WHERE orgnr = ?", [id])).toBeNull();
    }
    expect(await sql.first("SELECT 1 FROM organisation_fts WHERE name LIKE '%Andersson%'")).toBeNull();
  });

  it("geocodes workplaces against location addresses", async () => {
    const { sql } = await loaded();
    const row = await sql.first<{ n: number; total: number }>("SELECT sum(lat IS NOT NULL) AS n, count(*) AS total FROM workplace");
    expect(row!.n).toBe(row!.total);
  });

  it("looks up and searches organisations", async () => {
    const { queries, data } = await loaded();
    const org = await queries.organisation(data.organisations[0]!.orgnr);
    expect(org?.name).toBe("Kaffekollektivet AB");
    expect(org?.workplaceCount).toBe(2);
    expect(org?.sources[0]?.id).toBe("fixture");
    expect(await queries.organisation(data.naturalPersonIds[0]!)).toBeNull();
    const found = await queries.searchOrganisations({ query: "bryggeri" });
    expect(found.items.map((o) => o.name)).toEqual(["Bryggeri Väst AB"]);
    const page1 = await queries.searchOrganisations({}, 4);
    expect(page1.items).toHaveLength(4);
    const page2 = await queries.searchOrganisations({}, 4, page1.nextCursor);
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect((await queries.searchOrganisations({ kommun: "1480", sni: "62" })).items.map((o) => o.name)).toEqual(["Kodverkstaden AB"]);
  });

  it("finds workplaces near a point and an address, sorted by distance", async () => {
    const { queries, data } = await loaded();
    const near = await queries.workplacesNear({ point: FIXTURE_CENTER, radiusM: 2000, first: 100 });
    expect(near.items.length).toBe(12);
    const distances = near.items.map((w) => w.distanceM!);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    expect(near.items.every((w) => w.orgnr !== data.naturalPersonIds[0])).toBe(true);
    const byAddress = await queries.workplacesNear({ address: `${data.addresses[0]!.street} ${data.addresses[0]!.number}, ${data.addresses[0]!.postcode} Göteborg`, radiusM: 300 });
    expect(byAddress.center).not.toBeNull();
    const filtered = await queries.workplacesNear({ point: FIXTURE_CENTER, radiusM: 2000, sni: ["56"] });
    expect(filtered.items.every((w) => w.sni?.startsWith("56"))).toBe(true);
    const paged = await queries.workplacesNear({ point: FIXTURE_CENTER, radiusM: 2000, first: 5 });
    const next = await queries.workplacesNear({ point: FIXTURE_CENTER, radiusM: 2000, first: 5, after: paged.nextCursor });
    expect(next.items[0]!.distanceM).toBeGreaterThanOrEqual(paged.items[4]!.distanceM!);
    await expect(queries.workplacesNear({ point: { lat: 48.85, lon: 2.35 }, radiusM: 100 })).rejects.toThrow(/Sweden/);
  });

  it("geocodes free text and returns areas with statistics", async () => {
    const { queries, data } = await loaded();
    const hits = await queries.geocode("kaffegatan göteborg");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.street).toBe("Kaffegatan");
    const area = await queries.area({ deso: "1480C1010" });
    expect(area?.stats[0]?.value).toBe(1832);
    expect(area!.workplaceCount).toBeGreaterThan(0);
    const byPoint = await queries.area({ point: { lat: 57.705, lon: 11.95 } });
    expect(byPoint?.deso).toBe("1480C1010");
    expect(data.areas).toHaveLength(2);
  });

  it("reports source status with attribution", async () => {
    const { queries, repo } = await loaded();
    const run = await repo.startRun("scb-fr");
    await repo.finishRun(run, { status: "ok", rows: 10, skippedNaturalPersons: 3 });
    const status = await queries.sourceStatus();
    const scb = status.find((s) => s.id === "scb-fr")!;
    expect(scb.attribution).toMatch(/SCB/);
    expect(scb.lastRun?.skippedNaturalPersons).toBe(3);
  });
});
