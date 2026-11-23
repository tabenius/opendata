/** Worker-only routes and cron work. */
import type { Hono } from "hono";
import type { Services } from "@opendata/api";
import { timingSafeEqual } from "@opendata/rbq";
import { syncLatest } from "@opendata/datasets";
import { handleMcp } from "@opendata/mcp";
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
  app.all("/mcp", (c) => handleMcp(c.req.raw, { sql: services.sql, objects: services.objects, token: env.MCP_TOKEN }));
  app.post("/admin/import", async (c) => {
    if (!admin(env, c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await importTick(services, env));
  });
}

export async function scheduled(services: Services, env: Env): Promise<void> {
  try {
    await importTick(services, env);
  } catch (error) {
    // A held lease or a damaged snapshot: log and retry next tick.
    console.error("snapshot import tick failed:", error instanceof Error ? error.message : error);
  }
}
