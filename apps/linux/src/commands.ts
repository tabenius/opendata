/** Commands and routes added after M1: snapshots, SCB dumps (M3), MCP (M4), mail (M6), rbq repository (M7). */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "node:path";
import type { Hono } from "hono";
import type { Repository } from "@opendata/core";
import { MAX_MCP_BODY_BYTES, boundedRequest, type Services } from "@opendata/api";
import { latestSnapshot, publishDatabase, syncLatest, LAYER } from "@opendata/datasets";
import { fsckLayer, generateToken, listSnapshots } from "@opendata/rbq";
import { BolagsverketClient, PxClient, ScbFrClient, ingestBolagsverket, ingestPxTable } from "@opendata/sources";
import { handleMcp } from "@opendata/mcp";
import { MessageLog, OUTBOX, Watches, deliverOutbox } from "@opendata/mail";
import { serveStdio } from "@opendata/mcp/stdio";
import { readSecretFile, type Config } from "./config";

export function extendLinux(app: Hono, services: Services, config: Config): void {
  const token = config.mcp.token_file ? readSecretFile(config.mcp.token_file) : undefined;
  app.all("/mcp", async (c) => {
    const request = await boundedRequest(c.req.raw, MAX_MCP_BODY_BYTES);
    return request instanceof Response ? request : handleMcp(request, { sql: services.sql, objects: services.objects, token });
  });
  if (existsSync(path.join(config.pwa_dir, "index.html"))) {
    const root = path.relative(process.cwd(), config.pwa_dir) || ".";
    app.use("/*", serveStatic({ root }));
  }
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

export async function runCommand(
  command: string,
  sub: string | undefined,
  flags: Record<string, string | true>,
  services: Services,
  config: Config,
  repo: Repository,
): Promise<boolean> {
  if (command === "snapshot") {
    const label = str(flags.label) ?? config.snapshot.label;
    switch (sub) {
      case "publish":
        print(await publishDatabase(services.sql, services.objects, label, { chunkBytes: config.snapshot.chunk_bytes }));
        return true;
      case "list":
        print((await listSnapshots(services.objects, LAYER, str(flags.label))).map((m) => ({ id: m.id, created_at: m.created_at, files: m.files.length, owner: m.owner })));
        return true;
      case "fsck":
        print(await fsckLayer(services.objects, LAYER));
        return true;
      case "import": {
        const budget = Number(str(flags.budget) ?? 50000);
        for (;;) {
          const result = await syncLatest(services.sql, services.objects, label, budget);
          print(result);
          if (!result.state || result.state.done) return true;
        }
      }
      case "latest":
        print(await latestSnapshot(services.objects, label));
        return true;
    }
  }
  if (command === "mail" || command === "watches") {
    const log = new MessageLog(services.objects);
    if (command === "watches" && sub === "check") {
      if (!services.config.mailFrom || !services.mailer) {
        print({ skipped: "mail is not configured" });
        return true;
      }
      print(await new Watches(services.sql, services.objects, { publicUrl: services.config.publicUrl, from: services.config.mailFrom }).check());
      return true;
    }
    if (sub === "deliver") {
      if (!services.mailer) {
        print({ skipped: "mail is not configured" });
        return true;
      }
      print(await deliverOutbox(log, services.mailer, services.kv, { limit: Number(str(flags.limit) ?? 100) }));
      return true;
    }
    if (sub === "prune") {
      print({ removed: await log.pruneDelivered(OUTBOX, Number(str(flags.days) ?? 30)) });
      return true;
    }
    if (sub === "list") {
      const refs = await log.list(OUTBOX);
      print(await Promise.all(refs.map(async (r) => ({ key: r.key, delivered: Boolean(await log.receipt(r)) }))));
      return true;
    }
  }
  if (command === "rbq" && sub === "token") {
    print({ id: crypto.randomUUID(), token: generateToken(), note: "store the token in an owner-only file (chmod 600) and reference it as token_file" });
    return true;
  }
  if (command === "mcp") {
    await serveStdio(services.sql, services.objects);
    return true;
  }
  if (command === "dump" && sub === "scb") {
    // JSONL for `opendata-ingest build --scb-legal-units/--scb-workplaces`.
    const kommun = str(flags.kommun);
    const out = str(flags.out);
    if (!kommun || !out || !config.scb.api_key_file) throw new Error("dump scb needs --kommun, --out and scb.api_key_file");
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const client = new ScbFrClient({ apiKey: readSecretFile(config.scb.api_key_file), budget: Number(str(flags.budget) ?? 2000) });
    const legal = path.join(out, `legal-${kommun}.jsonl`);
    const work = path.join(out, `workplaces-${kommun}.jsonl`);
    writeFileSync(legal, "");
    writeFileSync(work, "");
    let rows = 0;
    for (const source of [client.legalUnitsInKommun(kommun), client.legalUnitsInLan(kommun.slice(0, 2))])
      for await (const page of source) {
        appendFileSync(legal, page.map((r) => JSON.stringify(r)).join("\n") + (page.length ? "\n" : ""));
        rows += page.length;
      }
    for await (const page of client.workplacesInKommun(kommun)) {
      appendFileSync(work, page.map((r) => JSON.stringify(r)).join("\n") + (page.length ? "\n" : ""));
      rows += page.length;
    }
    print({ legal, workplaces: work, rows, calls: client.calls });
    return true;
  }
  return false;
}
