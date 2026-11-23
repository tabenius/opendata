import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { Queries, Repository, fixtureDataset, migrations, withLuhn } from "@opendata/core";
import { ScbFrClient, ingestScbKommun } from "../src";

const ORG = withLuhn("556677881");
const PERSON = withLuhn("790101123");

/** A fake apiafr.scb.se with two pages of workplaces. */
function fakeScb() {
  const calls: string[] = [];
  const handler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (new Headers(init?.headers).get("X-API-Key") !== "test-key") return new Response("no", { status: 401 });
    const cursor = url.searchParams.get("cursorId");
    if (url.pathname === "/v1/juridiskaenheter/kommun/1480")
      return Response.json({ jes: [{ peOrgNr: ORG, jurform: 49, namn: "Testbolaget AB", jeStat: 1 }, { peOrgNr: `19${PERSON}`, jurform: 10, namn: "Privatperson" }], pagination: { hasMore: false } });
    if (url.pathname === "/v1/juridiskaenheter/lan/14") return Response.json({ jes: [], pagination: { hasMore: false } });
    if (url.pathname === "/v1/arbetsstallen/kommun/1480") {
      const a = fixtureDataset().addresses[3]!;
      const page = cursor === null
        ? [{ cfarNr: 41000001, peOrgNr: ORG, ben: "Testbolaget", primarNaringsgren: { naringsgren: "62010", avdelningsKod: "J" }, belagenhetsadress: { bGatuAdress: `${a.street} ${a.number}`, bPostNr: a.postcode, bPostOrt: "GÖTEBORG", kommun: "1480", lan: "14" }, aeStat: 1, anstKl: 3, reklamSparrTyp: 2 }]
        : [{ cfarNr: 41000002, peOrgNr: `19${PERSON}`, ben: null, belagenhetsadress: { bGatuAdress: "Hemvägen 1", bPostNr: "41101", kommun: "1480" } }];
      return Response.json({ arbetsstallen: page, pagination: cursor === null ? { hasMore: true, nextCursorId: 7 } : { hasMore: false } });
    }
    return new Response("not found", { status: 404 });
  };
  return { handler: handler as typeof fetch, calls };
}

describe("SCB företagsregistret connector", () => {
  it("pages with cursors, sends the key in X-API-Key, and drops natural persons", async () => {
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    const repo = new Repository(sql);
    await repo.upsertAddresses(fixtureDataset().addresses);
    const fake = fakeScb();
    const client = new ScbFrClient({ apiKey: "test-key", fetch: fake.handler, minIntervalMs: 0 });
    const result = await ingestScbKommun(client, repo, "1480", "2026-11-23");
    expect(fake.calls).toContain("/v1/arbetsstallen/kommun/1480?limit=2000&cursorId=7");
    expect(result.workplacesFetched).toBe(2);
    expect(result.skippedNaturalPersons).toBe(2);
    const q = new Queries(sql);
    const org = await q.organisation(ORG);
    expect(org?.name).toBe("Testbolaget AB");
    const wp = (await q.workplacesOf(ORG)).items[0]!;
    expect(wp.location).not.toBeNull();
    expect(wp.adBlock).toBe(true);
    expect(await sql.first("SELECT count(*) AS c FROM workplace")).toEqual({ c: 1 });
    expect((await q.sourceStatus()).find((s) => s.id === "scb-fr")?.lastRun?.status).toBe("ok");
  });

  it("refuses repeated cursors and bad region codes", async () => {
    const looping = (async () => Response.json({ arbetsstallen: [], pagination: { hasMore: true, nextCursorId: 1 } })) as unknown as typeof fetch;
    const client = new ScbFrClient({ apiKey: "k", fetch: looping, minIntervalMs: 0 });
    await expect(async () => {
      for await (const _ of client.workplacesInKommun("1480")) void _;
    }).rejects.toThrow(/repeated/);
    expect(() => client.workplacesInKommun("14")).toThrow();
  });

  it("retries 429 with Retry-After and respects a call budget", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : Response.json(5))) as unknown as typeof fetch;
    const slept: number[] = [];
    const client = new ScbFrClient({ apiKey: "k", fetch: flaky, minIntervalMs: 0, sleep: async (ms) => void slept.push(ms), budget: 2 });
    expect(await client.count("/arbetsstallen/kommun/1480")).toBe(5);
    expect(slept).toContain(1000);
    await expect(client.count("/x")).rejects.toThrow(/budget/);
  });
});
