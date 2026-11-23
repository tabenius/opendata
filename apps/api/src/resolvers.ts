import { createGraphQLError } from "graphql-yoga";
import { Queries, SOURCES, type Organisation, type Workplace } from "@opendata/core";
import type { Services } from "./services";

export interface Context {
  services: Services;
  queries: Queries;
  /** Set by the HTTP layer; used for watch rate limiting. */
  clientId: string;
}

function userError(error: unknown): never {
  if (error instanceof RangeError || error instanceof TypeError) throw createGraphQLError(error.message, { extensions: { code: "BAD_USER_INPUT" } });
  throw error;
}

const attribution = (...ids: (keyof typeof SOURCES)[]) => ids.map((id) => SOURCES[id].attribution);

export const resolvers = {
  Query: {
    organisation: (_: unknown, a: { orgnr: string }, c: Context) => c.queries.organisation(a.orgnr),
    organisations: async (_: unknown, a: { filter?: Record<string, string>; first?: number; after?: string }, c: Context) => {
      try {
        return await c.queries.searchOrganisations(a.filter ?? {}, a.first, a.after);
      } catch (e) {
        userError(e);
      }
    },
    workplacesNear: async (_: unknown, a: { point?: { lat: number; lon: number }; address?: string; radiusM?: number; sni?: string[]; first?: number; after?: string }, c: Context) => {
      try {
        const page = await c.queries.workplacesNear({ point: a.point ?? undefined, address: a.address ?? undefined, radiusM: a.radiusM, sni: a.sni ?? undefined, first: a.first, after: a.after });
        return { ...page, attribution: attribution("scb-fr", "lantmateriet-adress") };
      } catch (e) {
        userError(e);
      }
    },
    geocode: async (_: unknown, a: { address: string; limit?: number }, c: Context) => {
      if (a.address.length > 200) throw createGraphQLError("address is too long", { extensions: { code: "BAD_USER_INPUT" } });
      return (await c.queries.geocode(a.address, a.limit)).map((r) => ({ ...r, attribution: SOURCES["lantmateriet-adress"].attribution }));
    },
    area: async (_: unknown, a: { deso?: string; point?: { lat: number; lon: number } }, c: Context) => {
      const area = await c.queries.area({ deso: a.deso ?? undefined, point: a.point ?? undefined });
      return area && { ...area, attribution: attribution("scb-deso", "scb-px") };
    },
    sources: (_: unknown, __: unknown, c: Context) => c.queries.sourceStatus(),
  },
  Mutation: {
    watchArea: async (_: unknown, a: { email: string; kommun?: string; deso?: string; sniPrefix?: string }, c: Context) => {
      const { createWatch } = await import("./watch");
      return createWatch(c, a);
    },
  },
  Organisation: {
    workplaces: (o: Organisation, a: { first?: number; after?: string }, c: Context) => c.queries.workplacesOf(o.orgnr, a.first, a.after),
    annualReports: async (o: Organisation, _: unknown, c: Context) =>
      (await c.queries.annualReports(o.orgnr)).map((r) => ({ ...r, downloadPath: r.objectKey ? `/files/${r.objectKey}` : null })),
  },
  Workplace: {
    organisation: (w: Workplace, _: unknown, c: Context) => c.queries.organisation(w.orgnr),
  },
};
