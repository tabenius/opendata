import { createGraphQLError } from "graphql-yoga";
import { Queries, SOURCES, sniSection, SNI_SECTIONS, type Organisation, type Workplace } from "@opendata/core";
import { Loader } from "./loader";
import type { Services } from "./services";

export interface Context {
  services: Services;
  queries: Queries;
  /** Set by the HTTP layer; used for watch rate limiting. */
  clientId: string;
  /** Per-request batching; see `contextFor`. */
  loaders: Loaders;
}

export interface Loaders {
  organisation: Loader<string, Organisation>;
  sniTitle: Loader<string, string>;
}

export function loadersFor(queries: Queries): Loaders {
  return {
    organisation: new Loader((ids) => queries.organisationsByIds(ids)),
    sniTitle: new Loader((codes) => queries.sniTitles(codes)),
  };
}

const sniFields = (code: (parent: never) => string | null) => ({
  sniSection: (p: never) => sniSection(code(p)),
  sniTitle: (p: never, _: unknown, c: Context) => {
    const v = code(p);
    return v ? c.loaders.sniTitle.load(v) : null;
  },
});

function userError(error: unknown): never {
  if (error instanceof RangeError || error instanceof TypeError) throw createGraphQLError(error.message, { extensions: { code: "BAD_USER_INPUT" } });
  throw error;
}

const attribution = (...ids: (keyof typeof SOURCES)[]) => ids.map((id) => SOURCES[id].attribution);

/** Run a resolver; RangeError/TypeError from the core are the caller's mistake, not a 500. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    userError(e);
  }
}

export const resolvers = {
  Query: {
    organisation: (_: unknown, a: { orgnr: string }, c: Context) => guarded(() => c.queries.organisation(a.orgnr)),
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
      return guarded(async () => (await c.queries.geocode(a.address, a.limit)).map((r) => ({ ...r, attribution: SOURCES["lantmateriet-adress"].attribution })));
    },
    area: async (_: unknown, a: { deso?: string; point?: { lat: number; lon: number } }, c: Context) => {
      const area = await guarded(() => c.queries.area({ deso: a.deso ?? undefined, point: a.point ?? undefined }));
      return area && { ...area, attribution: attribution("scb-deso", "scb-px") };
    },
    sources: (_: unknown, __: unknown, c: Context) => c.queries.sourceStatus(),
    sniSections: () => SNI_SECTIONS,
  },
  Mutation: {
    watchArea: async (_: unknown, a: { email: string; kommun?: string; deso?: string; sniPrefix?: string }, c: Context) => {
      const { createWatch } = await import("./watch");
      return createWatch(c, a);
    },
  },
  Organisation: {
    ...sniFields((o: Organisation) => o.sniPrimary),
    workplaces: async (o: Organisation, a: { first?: number; after?: string }, c: Context) => ({
      ...(await guarded(() => c.queries.workplacesOf(o.orgnr, a.first, a.after))),
      attribution: attribution("scb-fr", "lantmateriet-adress"),
    }),
    annualReports: async (o: Organisation, _: unknown, c: Context) =>
      (await c.queries.annualReports(o.orgnr)).map((r) => ({ ...r, downloadPath: r.objectKey ? `/files/${r.objectKey}` : null })),
  },
  Workplace: {
    organisation: (w: Workplace, _: unknown, c: Context) => c.loaders.organisation.load(w.orgnr),
    ...sniFields((w: Workplace) => w.sni),
  },
};
