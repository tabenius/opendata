import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { createSchema, createYoga, type Plugin } from "graphql-yoga";
import { parseObjectKey, readStream, StorageError } from "@opendata/ports";
import { Queries } from "@opendata/core";
import { depthLimit, fieldLimit } from "./limits";
import { RateLimiter } from "./ratelimit";
import { restApi } from "./rest";
import { loadersFor, resolvers, type Context } from "./resolvers";
import { typeDefs } from "./schema";
import type { Services } from "./services";
import { watchesFor } from "./watch";
import { mountRbqRepositories } from "./rbq";

export const MAX_BODY_BYTES = 16 * 1024;
/** MCP tool calls are small JSON-RPC messages. */
export const MAX_MCP_BODY_BYTES = 64 * 1024;
export const MAX_URL_BYTES = 8 * 1024;

/**
 * Default client identity: Cloudflare's `cf-connecting-ip`, which clients
 * cannot set. Elsewhere pass `clientIdOf` (the Linux server derives it from the
 * socket, and from X-Real-IP only behind a configured trusted proxy).
 */
export function clientId(c: HonoContext): string {
  return c.req.header("cf-connecting-ip") ?? "anonymous";
}

/**
 * A copy of `request` whose body is at most `cap` bytes, or a 413 response.
 * Content-Length is not trusted (HTTP/2 and chunked bodies may omit it).
 */
export async function boundedRequest(request: Request, cap: number): Promise<Request | Response> {
  if (!request.body || request.method === "GET" || request.method === "HEAD") return request;
  try {
    const body = await readStream(request.body, cap);
    return new Request(request.url, { method: request.method, headers: request.headers, body: body as BodyInit });
  } catch {
    return new Response(JSON.stringify({ error: "request too large" }), { status: 413, headers: { "Content-Type": "application/json" } });
  }
}

/** Headers on every response. HTML additionally gets a CSP (see `HTML_CSP`). */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=()",
};

/** The PWA's policy; map tiles and styles come from OpenFreeMap. Keep in sync with apps/pwa/public/_headers. */
export const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org; " +
  "font-src 'self' https://tiles.openfreemap.org; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self' blob:; child-src blob:; " +
  "manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export interface ApiOptions {
  /** Mount extra routes (MCP, rbq repository) before the 404 handler. */
  extend?: (app: Hono) => void;
  /** Share one limiter across apps built per request (Workers build one per request). */
  limiter?: RateLimiter;
  /** How to identify a client for rate limiting; defaults to `clientId`. */
  clientIdOf?: (c: HonoContext) => string;
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
    context: ({ clientId }): Context => ({ services, queries, clientId, loaders: loadersFor(queries) }),
  });

  const who = options.clientIdOf ?? clientId;
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    if (c.res.headers.get("content-type")?.startsWith("text/html")) c.res.headers.set("Content-Security-Policy", HTML_CSP);
  });
  app.use(
    "*",
    cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization", "Mcp-Protocol-Version", "Mcp-Session-Id"], maxAge: 86400 }),
  );
  app.use("*", async (c, next) => {
    if (c.req.url.length > MAX_URL_BYTES) return c.json({ error: "request URI too long" }, 414);
    // Health checks, and rbq repositories (256-bit bearer tokens; a push is many small requests).
    if (c.req.path === "/healthz" || c.req.path.startsWith("/api/rbq/")) return next();
    const verdict = limiter.allow(who(c));
    if (!verdict.ok) return c.json({ error: "rate limited" }, 429, { "Retry-After": String(verdict.retryAfter) });
    if (Number(c.req.header("content-length") ?? 0) > MAX_MCP_BODY_BYTES && (c.req.path === "/graphql" || c.req.path === "/mcp")) {
      return c.json({ error: "request too large" }, 413);
    }
    return next();
  });

  app.get("/healthz", async (c) => {
    const row = await services.sql.first<{ v: string }>("SELECT value AS v FROM dataset_meta WHERE key = 'active_snapshot'").catch(() => null);
    return c.json({ ok: true, snapshot: row?.v ?? null, objects: services.objects.name, sql: services.sql.name, kv: services.kv.name });
  });

  app.on(["GET", "POST", "OPTIONS"], "/graphql", async (c) => {
    const request = await boundedRequest(c.req.raw, MAX_BODY_BYTES);
    return request instanceof Response ? request : yoga.fetch(request, { clientId: who(c) });
  });

  app.route("/api/v1", restApi(queries));

  // Stored public documents (annual reports, area geometries). Nothing else is served.
  app.get("/files/*", async (c) => {
    const key = c.req.path.slice("/files/".length);
    if (!/^(annual-reports|areas)\//.test(key)) return c.json({ error: "not found" }, 404);
    try {
      const objectKey = parseObjectKey(key);
      const meta = await services.objects.head(objectKey);
      const type = key.endsWith(".zip") ? "application/zip" : key.endsWith(".json") || key.endsWith(".geojson") ? "application/json" : "application/octet-stream";
      const filename = key.slice(key.lastIndexOf("/") + 1);
      return new Response(await services.objects.getStream(objectKey), {
        headers: {
          "Content-Type": type,
          "Content-Length": String(meta.size),
          // Downloads, never rendered inline: these are third-party documents.
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch (error) {
      if (error instanceof StorageError && (error.kind === "NotFound" || error.kind === "InvalidKey")) return c.json({ error: "not found" }, 404);
      throw error;
    }
  });

  const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const page = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${esc(title)}</h1>${body}</body>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
    );
  const tokenOf = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{48}$/.test(v) ? v : "");
  // GET only shows a button: mail scanners that open links must not confirm or cancel anything.
  const confirmForm = (action: string, token: string, label: string) =>
    `<form method="post" action="${action}"><input type="hidden" name="token" value="${esc(token)}"><button type="submit" style="font:inherit;padding:.6rem 1rem">${esc(label)}</button></form>`;
  app.get("/watch/confirm", (c) =>
    page("Bekräfta bevakning", `<p>Bekräfta att du vill få e-post om nya arbetsställen. / Confirm your watch.</p>${confirmForm("/watch/confirm", tokenOf(c.req.query("token")), "Bekräfta / Confirm")}`),
  );
  app.get("/watch/unsubscribe", (c) =>
    page("Avsluta bevakning", `<p>Vill du sluta få e-post om den här bevakningen? / Unsubscribe?</p>${confirmForm("/watch/unsubscribe", tokenOf(c.req.query("token")), "Avsluta / Unsubscribe")}`),
  );
  const formToken = async (c: HonoContext) => {
    const query = tokenOf(c.req.query("token"));
    if (query) return query; // RFC 8058 one-click POST carries the token in the URL
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > 4096) return "";
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    return tokenOf((form as Record<string, unknown>).token);
  };
  app.post("/watch/confirm", async (c) => {
    const ok = await watchesFor(services)?.confirm(await formToken(c));
    return ok ? page("Bevakningen är aktiv", "<p>Du får e-post när nya arbetsställen dyker upp. / Your watch is active.</p>") : page("Ogiltig länk", "<p>Länken är ogiltig, har gått ut eller är redan använd. / Invalid or expired link.</p>", 404);
  });
  app.post("/watch/unsubscribe", async (c) => {
    const ok = await watchesFor(services)?.unsubscribe(await formToken(c));
    return ok ? page("Bevakningen är borttagen", "<p>Inga fler utskick. / You are unsubscribed.</p>") : page("Ogiltig länk", "<p>Länken är ogiltig eller redan använd. / Invalid link.</p>", 404);
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
