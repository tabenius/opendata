import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { FIXTURE_CENTER, Repository, fixtureDataset, migrations } from "@opendata/core";
import { createMcpServer, handleMcp } from "../src";

async function db() {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  const repo = new Repository(sql);
  const d = fixtureDataset();
  await repo.upsertAddresses(d.addresses);
  await repo.upsertOrganisations(d.organisations);
  await repo.upsertWorkplaces(d.workplaces);
  await repo.upsertAreas(d.areas);
  await repo.upsertAreaStats(d.stats);
  return { sql, d };
}

const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

describe("MCP server", () => {
  it("lists read-only tools and answers them", async () => {
    const { sql, d } = await db();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(sql).connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["annual_reports", "area_profile", "geocode_address", "lookup_organisation", "search_organisations", "source_status", "workplaces_near"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);

    const org = json(await client.callTool({ name: "lookup_organisation", arguments: { orgnr: d.organisations[2]!.orgnr } }));
    expect(org.result.name).toBe("Kodverkstaden AB");
    expect(org.attribution[0]).toMatch(/SCB/);

    const person = json(await client.callTool({ name: "lookup_organisation", arguments: { orgnr: d.naturalPersonIds[0] } }));
    expect(person.result).toBeNull();

    const near = json(await client.callTool({ name: "workplaces_near", arguments: { lat: FIXTURE_CENTER.lat, lon: FIXTURE_CENTER.lon, radiusM: 3000, first: 100 } }));
    expect(near.result.items).toHaveLength(12);

    const area = json(await client.callTool({ name: "area_profile", arguments: { deso: "1480C1020" } }));
    expect(area.result.stats[0].value).toBe(2410);

    const bad = await client.callTool({ name: "workplaces_near", arguments: { radiusM: 100 } });
    expect(bad.isError).toBe(true);
    const outside = await client.callTool({ name: "workplaces_near", arguments: { lat: 48.8, lon: 2.3 } });
    expect(outside.isError).toBe(true);
    await client.close();
  });

  it("serves Streamable HTTP statelessly with an optional bearer token", async () => {
    const { sql } = await db();
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => handleMcp(new Request(input, init), { sql, token: "s3cret" })) as typeof fetch;
    const denied = await fetcher("http://x/mcp", { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    const transport = new StreamableHTTPClientTransport(new URL("http://x/mcp"), { fetch: fetcher, requestInit: { headers: { Authorization: "Bearer s3cret" } } });
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(transport);
    const r = json(await client.callTool({ name: "search_organisations", arguments: { query: "bageri" } }));
    expect(r.result.items[0].name).toBe("Bageri Solen AB");
    await client.close();
  });
});
