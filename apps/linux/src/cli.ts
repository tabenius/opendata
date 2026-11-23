/**
 * opendata — Linux CLI.
 *
 *   opendata serve                         HTTP: GraphQL, MCP, files, rbq repository
 *   opendata migrate                       apply SQL migrations
 *   opendata config explain                effective configuration (secrets redacted)
 *   opendata ingest fixture                load the fictional demo dataset
 *   opendata ingest scb --kommun 1480      SCB företagsregistret, one kommun
 *   opendata ingest bolagsverket --orgnr A,B [--file F] [--documents]
 *   opendata ingest px [--table ID --region-dim Region --filter "Dim=a,b;Dim2=c"]
 *   opendata dump scb --kommun 1480 --out DIR   SCB API rows as JSONL for opendata-ingest
 *   opendata snapshot publish|list|fsck|latest|import [--label L] [--budget N]
 *   opendata watches check                 queue alert mail for confirmed watches
 *   opendata mail deliver|list|prune [--days 30]   outbox delivery (SMTP/Resend)
 *   opendata mcp                           MCP over stdio (for Claude Desktop / Claude Code)
 *
 * Global: --config PATH, --data-dir DIR, --listen HOST:PORT, --public-url URL
 */
import { serve } from "@hono/node-server";
import { createApi } from "@opendata/api";
import { Repository, fixtureDataset } from "@opendata/core";
import { ScbFrClient, ingestScbKommun } from "@opendata/sources";
import { explain, loadConfig, readSecretFile } from "./config";
import { compose } from "./compose";
import { extendLinux, runCommand } from "./commands";

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags[name!] = inline;
      else if (next !== undefined && !next.startsWith("--")) {
        flags[name!] = next;
        i++;
      } else flags[name!] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

async function main(argv: string[]) {
  const { positional, flags } = parseArgs(argv);
  const [command, sub] = positional;
  const { config, files } = loadConfig({
    configPath: str(flags.config),
    overrides: { listen: str(flags.listen), public_url: str(flags["public-url"]), data_dir: str(flags["data-dir"]) },
  });
  if (command === "config") {
    console.log(JSON.stringify({ files, config: explain(config) }, null, 2));
    return;
  }
  if (!command || command === "help" || flags.help) {
    console.log((await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace(/^\/\*\*?|^ \* ?/gm, ""));
    return;
  }
  const services = await compose(config);
  const repo = new Repository(services.sql);
  try {
    switch (command) {
      case "migrate":
        console.log(JSON.stringify({ ok: true, database: config.sql.file }));
        return;
      case "serve": {
        const app = createApi(services, { extend: (a) => extendLinux(a, services, config) });
        const [host, port] = config.listen.split(":");
        serve({ fetch: app.fetch, hostname: host, port: Number(port) }, (info) => console.error(`opendata listening on http://${info.address}:${info.port}`));
        await new Promise(() => undefined);
        return;
      }
      case "ingest":
        if (sub === "fixture") {
          const d = fixtureDataset();
          const run = await repo.startRun("fixture");
          await repo.upsertAddresses(d.addresses);
          const o = await repo.upsertOrganisations(d.organisations);
          const w = await repo.upsertWorkplaces(d.workplaces);
          await repo.upsertAreas(d.areas);
          await repo.upsertAreaStats(d.stats);
          await repo.finishRun(run, { status: "ok", rows: o.written + w.written, skippedNaturalPersons: o.skippedNaturalPersons + w.skippedNaturalPersons });
          console.log(JSON.stringify({ organisations: o, workplaces: w }));
          return;
        }
        if (sub === "scb") {
          const kommun = str(flags.kommun);
          if (!kommun || !config.scb.api_key_file) throw new Error("ingest scb needs --kommun and scb.api_key_file");
          const client = new ScbFrClient({ apiKey: readSecretFile(config.scb.api_key_file), budget: Number(str(flags.budget) ?? 2000) });
          console.log(JSON.stringify(await ingestScbKommun(client, repo, kommun)));
          return;
        }
        break;
    }
    if (await runCommand(command, sub, flags, services, config, repo)) return;
    throw new Error(`unknown command: ${positional.join(" ")} (try: opendata help)`);
  } finally {
    if (command !== "serve" && command !== "mcp") {
      await services.kv.close?.();
      await services.sql.close();
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`opendata: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  });
}

export { main };
