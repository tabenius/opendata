/** Commands and routes added after M1: snapshots, SCB dumps (M3), MCP (M4), mail (M6), rbq repository (M7). */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import type { Repository } from "@opendata/core";
import type { Services } from "@opendata/api";
import { latestSnapshot, publishDatabase, syncLatest, LAYER } from "@opendata/datasets";
import { fsckLayer, listSnapshots } from "@opendata/rbq";
import { ScbFrClient } from "@opendata/sources";
import { readSecretFile, type Config } from "./config";

export function extendLinux(_app: Hono, _services: Services, _config: Config): void {}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

export async function runCommand(
  command: string,
  sub: string | undefined,
  flags: Record<string, string | true>,
  services: Services,
  config: Config,
  _repo: Repository,
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
