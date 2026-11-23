/**
 * REST /api/v1: the same read queries as GraphQL, for clients that want
 * plain URLs and HTTP caching. Responses carry a weak ETag derived from the
 * data version (active snapshot + last ingest run) and the URL, so a
 * client revalidates cheaply and gets 304 until the data changes.
 */
import { Hono, type Context as HonoContext } from "hono";
import { Queries, SOURCES, SNI_SECTIONS, sniSection, type Organisation, type Workplace } from "@opendata/core";
import { openapi } from "./openapi";

const CACHE = "public, max-age=300, stale-while-revalidate=3600";

async function etagOf(version: string, url: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${version}\n${url}`)));
  return `W/"${[...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function problem(c: HonoContext, status: 400 | 404, detail: string) {
  return c.json({ type: "about:blank", title: status === 400 ? "Bad Request" : "Not Found", status, detail }, status, { "Content-Type": "application/problem+json" });
}

const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const point = (c: HonoContext) => {
  const lat = num(c.req.query("lat"));
  const lon = num(c.req.query("lon"));
  if (lat === undefined && lon === undefined) return undefined;
  if (lat === undefined || lon === undefined) throw new RangeError("lat and lon go together");
  return { lat, lon };
};

const withSni = <T extends { sni?: string | null; sniPrimary?: string | null }>(x: T) => ({ ...x, sniSection: sniSection(x.sni ?? x.sniPrimary) });
const workplaceAttribution = [SOURCES["scb-fr"].attribution, SOURCES["lantmateriet-adress"].attribution];

export function restApi(queries: Queries): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof RangeError || error instanceof TypeError) return problem(c, 400, error.message);
    throw error;
  });

  app.get("/openapi.json", (c) => c.json(openapi, 200, { "Cache-Control": "public, max-age=3600" }));

  // Conditional GET for everything below.
  app.use("*", async (c, next) => {
    const tag = await etagOf(await queries.dataVersion(), c.req.url);
    const match = c.req.header("if-none-match");
    if (match && match.split(",").some((t) => t.trim() === tag || t.trim() === "*")) {
      return c.body(null, 304, { ETag: tag, "Cache-Control": CACHE });
    }
    await next();
    if (c.res.status === 200) {
      c.res.headers.set("ETag", tag);
      c.res.headers.set("Cache-Control", CACHE);
      c.res.headers.append("Vary", "Accept-Encoding");
    }
  });

  app.get("/sources", async (c) => c.json({ items: await queries.sourceStatus() }));
  app.get("/sni/sections", (c) => c.json({ items: SNI_SECTIONS }));
  app.get("/sni/:code", async (c) => {
    const row = await queries.sni(c.req.param("code"));
    return row ? c.json({ ...row, section: sniSection(row.code) }) : problem(c, 404, "unknown SNI code");
  });

  app.get("/organisations", async (c) => {
    const q = c.req.query();
    const page = await queries.searchOrganisations(
      { query: q.query, sni: q.sni, town: q.town, kommun: q.kommun, legalFormCode: q.legalFormCode, status: q.status },
      num(q.first),
      q.after,
    );
    return c.json({ ...page, items: page.items.map(withSni), attribution: [SOURCES["scb-fr"].attribution] });
  });

  app.get("/organisations/:orgnr", async (c) => {
    const org = await queries.organisation(c.req.param("orgnr"));
    if (!org) return problem(c, 404, "no such organisation (natural persons are never returned)");
    return c.json({ ...withSni(org as Organisation & { workplaceCount: number }), annualReports: await queries.annualReports(org.orgnr) });
  });

  app.get("/organisations/:orgnr/workplaces", async (c) => {
    const page = await queries.workplacesOf(c.req.param("orgnr"), num(c.req.query("first")), c.req.query("after"));
    return c.json({ ...page, items: page.items.map(withSni), attribution: workplaceAttribution });
  });

  app.get("/workplaces/near", async (c) => {
    const page = await queries.workplacesNear({
      point: point(c),
      address: c.req.query("address"),
      radiusM: num(c.req.query("radius")),
      sni: list(c.req.query("sni")),
      first: num(c.req.query("first")),
      after: c.req.query("after"),
    });
    return c.json({ ...page, items: page.items.map((w: Workplace) => withSni(w)), attribution: workplaceAttribution });
  });

  app.get("/geocode", async (c) => {
    const q = c.req.query("q");
    if (!q) return problem(c, 400, "q is required");
    return c.json({ items: await queries.geocode(q, num(c.req.query("limit"))), attribution: [SOURCES["lantmateriet-adress"].attribution] });
  });

  app.get("/areas/:deso", async (c) => {
    const area = await queries.area({ deso: c.req.param("deso") });
    return area ? c.json(area) : problem(c, 404, "no such DeSO");
  });
  app.get("/areas", async (c) => {
    const p = point(c);
    if (!p) return problem(c, 400, "lat and lon are required");
    const area = await queries.area({ point: p });
    return area ? c.json(area) : problem(c, 404, "no DeSO contains that point");
  });

  return app;
}
