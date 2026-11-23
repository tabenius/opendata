/** Worker-only routes and cron work, filled in by M3 (import), M4 (MCP), M6 (mail), M7 (rbq). */
import type { Hono } from "hono";
import type { Services } from "@opendata/api";
import type { Env } from "./env";

export function extendWorker(_app: Hono, _services: Services, _env: Env, _ctx: { waitUntil(p: Promise<unknown>): void }) {}

export async function scheduled(_services: Services, _env: Env): Promise<void> {}
