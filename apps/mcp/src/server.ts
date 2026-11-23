/**
 * MCP server over the same core queries as GraphQL. Read-only tools; every
 * result carries source attribution. Natural persons are never in the data.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Queries, SOURCES, type SourceId } from "@opendata/core";
import type { ObjectStore, SqlStore } from "@opendata/ports";

export const SERVER_INFO = { name: "opendata-sweden", version: "0.1.0" };

const INSTRUCTIONS = `Swedish open government data about legal entities (companies, associations, authorities), their workplaces, location addresses and statistical areas (DeSO).
Sources: SCB företagsregistret, Bolagsverket värdefulla datamängder, Lantmäteriet belägenhetsadresser, SCB statistikdatabasen.
Natural persons (sole traders, estates) are deliberately excluded and cannot be looked up. Respect adBlock (direct-marketing opt-out) flags.
Cite the attribution strings returned with each result.`;

function attribution(...ids: SourceId[]) {
  return ids.map((id) => SOURCES[id].attribution);
}

function result(value: unknown, sources: SourceId[]) {
  const payload = { result: value, attribution: attribution(...sources) };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function failure(error: unknown) {
  const message = error instanceof RangeError || error instanceof TypeError ? error.message : "the query failed";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const point = { lat: z.number().min(55).max(69.2).optional(), lon: z.number().min(10.5).max(24.3).optional() };
const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true };

export function createMcpServer(sql: SqlStore, objects?: ObjectStore): McpServer {
  const queries = new Queries(sql, objects);
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const wrap = <A>(sources: SourceId[], fn: (args: A) => Promise<unknown>) => async (args: A) => {
    try {
      return result(await fn(args), sources);
    } catch (error) {
      return failure(error);
    }
  };

  server.registerTool(
    "lookup_organisation",
    {
      title: "Look up an organisation",
      description: "Legal entity by organisationsnummer (10 digits, with or without hyphen). Returns null for unknown numbers and for personnummer.",
      inputSchema: { orgnr: z.string().min(10).max(13) },
      annotations: READ_ONLY,
    },
    wrap(["scb-fr", "bolagsverket-hvd"], async ({ orgnr }: { orgnr: string }) => queries.organisation(orgnr)),
  );

  server.registerTool(
    "search_organisations",
    {
      title: "Search organisations",
      description: "Search legal entities by name words, SNI code prefix, postal town, kommun code (4 digits), legal form code (AB, HB, EK, ...) or status. Cursor paging.",
      inputSchema: {
        query: z.string().max(100).optional(),
        sni: z.string().regex(/^\d{1,5}$/).optional(),
        town: z.string().max(60).optional(),
        kommun: z.string().regex(/^\d{4}$/).optional(),
        legalFormCode: z.string().max(5).optional(),
        status: z.enum(["active", "inactive", "deregistered", "unknown"]).optional(),
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().max(512).optional(),
      },
      annotations: READ_ONLY,
    },
    wrap(["scb-fr", "bolagsverket-hvd"], async (a: { query?: string; sni?: string; town?: string; kommun?: string; legalFormCode?: string; status?: string; first?: number; after?: string }) =>
      queries.searchOrganisations({ query: a.query, sni: a.sni, town: a.town, kommun: a.kommun, legalFormCode: a.legalFormCode, status: a.status }, a.first, a.after),
    ),
  );

  server.registerTool(
    "workplaces_near",
    {
      title: "Workplaces near a place",
      description: "Workplaces of legal entities within a radius (max 5000 m) of an address (\"Street 12, 41101 Town\") or a WGS 84 point, nearest first. Optional SNI prefixes.",
      inputSchema: {
        address: z.string().max(200).optional(),
        ...point,
        radiusM: z.number().int().min(1).max(5000).optional(),
        sni: z.array(z.string().regex(/^\d{1,5}$/)).max(10).optional(),
        first: z.number().int().min(1).max(100).optional(),
        after: z.string().max(512).optional(),
      },
      annotations: READ_ONLY,
    },
    wrap(["scb-fr", "lantmateriet-adress"], async (a: { address?: string; lat?: number; lon?: number; radiusM?: number; sni?: string[]; first?: number; after?: string }) => {
      if (!a.address && (a.lat === undefined || a.lon === undefined)) throw new RangeError("give an address or both lat and lon");
      return queries.workplacesNear({
        address: a.address,
        point: a.lat !== undefined && a.lon !== undefined ? { lat: a.lat, lon: a.lon } : undefined,
        radiusM: a.radiusM,
        sni: a.sni,
        first: a.first,
        after: a.after,
      });
    }),
  );

  server.registerTool(
    "geocode_address",
    {
      title: "Geocode an address",
      description: "Lantmäteriet location address to WGS 84 coordinates and DeSO area.",
      inputSchema: { address: z.string().min(2).max(200), limit: z.number().int().min(1).max(20).optional() },
      annotations: READ_ONLY,
    },
    wrap(["lantmateriet-adress"], async (a: { address: string; limit?: number }) => queries.geocode(a.address, a.limit)),
  );

  server.registerTool(
    "area_profile",
    {
      title: "Area profile",
      description: "DeSO area (by code or by WGS 84 point) with its statistics and number of geocoded workplaces.",
      inputSchema: { deso: z.string().regex(/^\d{4}[A-C]\d{4}$/).optional(), ...point },
      annotations: READ_ONLY,
    },
    wrap(["scb-deso", "scb-px"], async (a: { deso?: string; lat?: number; lon?: number }) => {
      if (!a.deso && (a.lat === undefined || a.lon === undefined)) throw new RangeError("give a deso code or both lat and lon");
      return queries.area({ deso: a.deso, point: a.lat !== undefined && a.lon !== undefined ? { lat: a.lat, lon: a.lon } : undefined });
    }),
  );

  server.registerTool(
    "annual_reports",
    {
      title: "Annual reports",
      description: "Digitally filed annual reports of an organisation (Bolagsverket), with download paths when stored.",
      inputSchema: { orgnr: z.string().min(10).max(13) },
      annotations: READ_ONLY,
    },
    wrap(["bolagsverket-hvd"], async (a: { orgnr: string }) =>
      (await queries.annualReports(a.orgnr)).map((r) => ({ ...r, downloadPath: r.objectKey ? `/files/${r.objectKey}` : null })),
    ),
  );

  server.registerTool(
    "source_status",
    {
      title: "Data sources",
      description: "Each source with licence, attribution text and the last ingest run.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    wrap([], async () => queries.sourceStatus()),
  );

  return server;
}
