/** Worker-only routes and cron work. */
import type { Hono } from "hono";
import { MAX_MCP_BODY_BYTES, boundedRequest, type Services } from "@opendata/api";
import { timingSafeEqual } from "@opendata/rbq";
import { syncLatest } from "@opendata/datasets";
import { handleMcp } from "@opendata/mcp";
import { MessageLog, Watches, deliverOutbox } from "@opendata/mail";
import type { Env } from "./env";

/** Rows imported per cron tick; D1 batches keep each tick well inside Worker limits. */
const DEFAULT_ROWS_PER_TICK = 20000;

export async function importTick(services: Services, env: Env) {
  return syncLatest(services.sql, services.objects, env.SNAPSHOT_LABEL ?? "local", Number(env.IMPORT_ROWS_PER_TICK ?? DEFAULT_ROWS_PER_TICK));
}

function admin(env: Env, header: string | undefined): boolean {
  return Boolean(env.ADMIN_TOKEN && header && timingSafeEqual(header, `Bearer ${env.ADMIN_TOKEN}`));
}

export function extendWorker(app: Hono, services: Services, env: Env, _ctx: { waitUntil(p: Promise<unknown>): void }) {
  app.all("/mcp", async (c) => {
    const request = await boundedRequest(c.req.raw, MAX_MCP_BODY_BYTES);
    return request instanceof Response ? request : handleMcp(request, { sql: services.sql, objects: services.objects, token: env.MCP_TOKEN });
  });
  app.post("/admin/mail", async (c) => {
    if (!admin(env, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await mailTick(services));
  });
  app.post("/admin/import", async (c) => {
    if (!admin(env, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await importTick(services, env));
  });
}

export async function mailTick(services: Services) {
  if (!services.mailer || !services.config.mailFrom) return null;
  const watches = await new Watches(services.sql, services.objects, { publicUrl: services.config.publicUrl, from: services.config.mailFrom }).check();
  const delivery = await deliverOutbox(new MessageLog(services.objects), services.mailer, services.kv, { limit: 50 });
  return { watches, delivery };
}

export async function scheduled(services: Services, env: Env): Promise<void> {
  for (const [name, task] of [["snapshot import", () => importTick(services, env)], ["mail", () => mailTick(services)]] as const) {
    try {
      await task();
    } catch (error) {
      // A held lease, a damaged snapshot or a mail outage: log and retry next tick.
      console.error(`${name} tick failed:`, error instanceof Error ? error.message : error);
    }
  }
}
