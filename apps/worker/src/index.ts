import { createApi } from "@opendata/api";
import { compose, ready } from "./compose";
import type { Env } from "./env";
import { extendWorker, scheduled } from "./routes";

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const services = compose(env);
    await ready();
    const app = createApi(services, { extend: (a) => extendWorker(a, services, env, ctx) });
    return app.fetch(request);
  },
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const services = compose(env);
    await ready();
    ctx.waitUntil(scheduled(services, env));
  },
};
