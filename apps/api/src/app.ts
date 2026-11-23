import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { createSchema, createYoga, type Plugin } from "graphql-yoga";
import { parseObjectKey, StorageError } from "@opendata/ports";
import { Queries } from "@opendata/core";
import { depthLimit, fieldLimit } from "./limits";
import { RateLimiter } from "./ratelimit";
import { resolvers, type Context } from "./resolvers";
import { typeDefs } from "./schema";
import type { Services } from "./services";
import { watchesFor } from "./watch";
import { mountRbqRepositories } from "./rbq";

export const MAX_BODY_BYTES = 16 * 1024;

export function clientId(c: HonoContext): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "local";
}

export interface ApiOptions {
  /** Mount extra routes (MCP, rbq repository) before the 404 handler. */
  extend?: (app: Hono) => void;
  /** Share one limiter across apps built per request (Workers build one per request). */
  limiter?: RateLimiter;
}

export function createApi(services: Services, options: ApiOptions = {}) {
  const queries = new Queries(services.sql, services.objects);
  const limiter = options.limiter ?? new RateLimiter(services.config.rateLimitPerMinute ?? 120);
  const maxDepth = services.config.maxDepth ?? 8;
  const limitsPlugin: Plugin = {
    onValidate({ addValidationRule }) {
      addValidationRule(depthLimit(maxDepth));
      addValidationRule(fieldLimit(300));
    },
  };
  const yoga = createYoga<{ clientId: string }>({
    schema: createSchema({ typeDefs, resolvers }),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    maskedErrors: true,
    plugins: [limitsPlugin],
    context: ({ clientId }): Context => ({ services, queries, clientId }),
  });

  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));
  app.use("*", async (c, next) => {
    // Health checks, and rbq repositories (256-bit bearer tokens; a push is many small requests).
    if (c.req.path === "/healthz" || c.req.path.startsWith("/api/rbq/")) return next();
    const verdict = limiter.allow(clientId(c));
    if (!verdict.ok) return c.json({ error: "rate limited" }, 429, { "Retry-After": String(verdict.retryAfter) });
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_BODY_BYTES && c.req.path === "/graphql") return c.json({ error: "request too large" }, 413);
    return next();
  });

  app.get("/healthz", async (c) => {
    const row = await services.sql.first<{ v: string }>("SELECT value AS v FROM dataset_meta WHERE key = 'active_snapshot'").catch(() => null);
    return c.json({ ok: true, snapshot: row?.v ?? null, objects: services.objects.name, sql: services.sql.name, kv: services.kv.name });
  });

  app.on(["GET", "POST", "OPTIONS"], "/graphql", (c) => yoga.fetch(c.req.raw, { clientId: clientId(c) }));

  // Stored public documents (annual reports, area geometries). Nothing else is served.
  app.get("/files/*", async (c) => {
    const key = c.req.path.slice("/files/".length);
    if (!/^(annual-reports|areas)\//.test(key)) return c.json({ error: "not found" }, 404);
    try {
      const objectKey = parseObjectKey(key);
      const meta = await services.objects.head(objectKey);
      const type = key.endsWith(".zip") ? "application/zip" : key.endsWith(".json") || key.endsWith(".geojson") ? "application/json" : "application/octet-stream";
      return new Response(await services.objects.getStream(objectKey), {
        headers: { "Content-Type": type, "Content-Length": String(meta.size), "Cache-Control": "public, max-age=86400" },
      });
    } catch (error) {
      if (error instanceof StorageError && (error.kind === "NotFound" || error.kind === "InvalidKey")) return c.json({ error: "not found" }, 404);
      throw error;
    }
  });

  const page = (title: string, body: string, status = 200) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  app.get("/watch/confirm", async (c) => {
    const ok = await watchesFor(services)?.confirm(c.req.query("token") ?? "");
    return ok ? page("Bevakningen är aktiv", "Du får e-post när nya arbetsställen dyker upp. / Your watch is active.") : page("Ogiltig länk", "Länken är ogiltig eller redan använd. / Invalid link.", 404);
  });
  app.get("/watch/unsubscribe", async (c) => {
    const ok = await watchesFor(services)?.unsubscribe(c.req.query("token") ?? "");
    return ok ? page("Bevakningen är borttagen", "Inga fler utskick. / You are unsubscribed.") : page("Ogiltig länk", "Länken är ogiltig eller redan använd. / Invalid link.", 404);
  });

  if (services.config.rbqRepositories && Object.keys(services.config.rbqRepositories).length) {
    mountRbqRepositories(app, { objects: services.objects, sql: services.sql, publicUrl: services.config.publicUrl, repositories: services.config.rbqRepositories });
  }

  options.extend?.(app);
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((error, c) => {
    console.error("request failed", c.req.method, c.req.path, error instanceof Error ? error.message : error);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
