import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { migrate } from "@opendata/adapters-sql";
import { Queries, Repository, fixtureDataset, migrations, withLuhn } from "@opendata/core";
import { parseObjectKey } from "@opendata/ports";
import { BolagsverketClient, PxClient, flattenJsonStat, ingestBolagsverket, ingestPxTable, type JsonStat2 } from "../src";

async function db() {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  return { sql, repo: new Repository(sql), q: new Queries(sql) };
}

const ORG = withLuhn("556677882");
const PERSON = withLuhn("850612123");

function fakeBolagsverket() {
  const seen: string[] = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/oauth2/token") {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${btoa("cid:secret")}`);
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
    if (url.pathname.endsWith("/organisationer")) {
      const id = JSON.parse(String(init?.body)).identitetsbeteckning;
      return Response.json({
        organisationer: [
          {
            organisationsidentitet: { identitetsbeteckning: id, typ: { kod: "ORGNR" } },
            organisationsnamn: { organisationsnamnLista: [{ namn: "Annualia AB", organisationsnamntyp: { kod: "FORETAGSNAMN" } }] },
            organisationsform: { kod: "AB", klartext: "Aktiebolag" },
            verksamhetsbeskrivning: { beskrivning: "Bokföring." },
            postadressOrganisation: { postadress: { utdelningsadress: "Box 9", postnummer: "41101", postort: "GÖTEBORG" } },
            naringsgrenOrganisation: { sni: [{ kod: "69201", klartext: "Redovisning" }] },
          },
        ],
      });
    }
    if (url.pathname.endsWith("/dokumentlista")) return Response.json({ dokument: [{ dokumentId: "doc-2025", filformat: "zip", rapporteringsperiodTom: "2025-12-31", registreringstidpunkt: "2026-03-01" }] });
    if (url.pathname.endsWith("/dokument/doc-2025")) return new Response(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]), { headers: { "Content-Type": "application/zip" } });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { handler, seen };
}

describe("Bolagsverket värdefulla datamängder", () => {
  it("authenticates, maps organisations, stores annual reports, and never queries persons", async () => {
    const { repo, q } = await db();
    const objects = new MemoryObjectStore();
    const fake = fakeBolagsverket();
    const client = new BolagsverketClient({ clientId: "cid", clientSecret: "secret", fetch: fake.handler, minIntervalMs: 0, tokenUrl: "https://x/oauth2/token", baseUrl: "https://x/vdm/v1" });
    const result = await ingestBolagsverket(client, repo, [ORG, PERSON], { objects, documents: true, sourceDate: "2026-11-23" });
    expect(result.skippedNaturalPersons).toBe(1);
    expect(result.documents).toBe(1);
    expect(fake.seen.filter((s) => s.startsWith("POST /oauth2"))).toHaveLength(1);
    expect(fake.seen.join(" ")).not.toContain(PERSON);
    const org = await q.organisation(ORG);
    expect(org).toMatchObject({ name: "Annualia AB", legalForm: "Aktiebolag", sniPrimary: "69201", businessDescription: "Bokföring." });
    const reports = await q.annualReports(ORG);
    expect(reports[0]).toMatchObject({ documentId: "doc-2025", periodEnd: "2025-12-31", sizeBytes: 7 });
    expect((await objects.get(parseObjectKey(reports[0]!.objectKey!))).length).toBe(7);
  });
});

describe("SCB PxWebApi v2", () => {
  const doc: JsonStat2 = {
    id: ["Region", "Kon", "Tid"],
    size: [2, 2, 1],
    dimension: {
      Region: { category: { index: { "1480C1010": 0, "1480C1020": 1 } } },
      Kon: { label: "kön", category: { index: { "1": 0, "2": 1 }, label: { "1": "män", "2": "kvinnor" } } },
      Tid: { category: { index: { "2025": 0 } } },
    },
    value: [900, 932, 1200, 1210],
  };

  it("flattens JSON-stat 2.0 row-major", () => {
    const cells = flattenJsonStat(doc);
    expect(cells).toHaveLength(4);
    expect(cells[1]).toMatchObject({ coords: { Region: "1480C1010", Kon: "2", Tid: "2025" }, value: 932 });
    expect(cells[3]!.labels.Kon).toBe("kvinnor");
  });

  it("batches regions and stores area statistics", async () => {
    const { sql, repo, q } = await db();
    const r = new Repository(sql);
    await r.upsertAreas(fixtureDataset().areas);
    const urls: string[] = [];
    const client = new PxClient({ minIntervalMs: 0, fetch: (async (input: RequestInfo | URL) => (urls.push(String(input)), Response.json(doc))) as typeof fetch });
    const result = await ingestPxTable(client, repo, { id: "TAB9999", filters: { Kon: "1,2" } }, ["1480C1010", "1480C1020"], 1);
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[0]!)).toContain("valueCodes[Region]=1480C1010");
    expect(result.written).toBe(8);
    const area = await q.area({ deso: "1480C1020" });
    expect(area?.stats.find((s) => s.variable === "Kon=2")?.value).toBe(1210);
  });
});
