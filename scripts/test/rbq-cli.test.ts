/**
 * The real rbq CLI (tabenius/rebsync) against our rbq-repository.v1 server.
 * Set RBQ_BIN to an rbq binary; skipped otherwise.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { FsObjectStore } from "@opendata/adapters-object/fs";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { MemoryKvStore } from "@opendata/adapters-kv";
import { migrate } from "@opendata/adapters-sql";
import { createApi } from "@opendata/api";
import { migrations } from "@opendata/core";
import { generateToken } from "@opendata/rbq";

const RBQ = process.env.RBQ_BIN ?? "/home/claude/tabenius/rebsync/target/release/rbq";
const available = existsSync(RBQ);
const rust = fileURLToPath(new URL("../../rust/", import.meta.url));
const ID = "6f1c1d0e-5a6b-4c2d-9e8f-7a6b5c4d3e2f";

describe.skipIf(!available)("rbq CLI against /api/rbq", () => {
  let server: ServerType;
  let endpoint: string;
  let tokenFile: string;
  let dir: string;
  let objects: FsObjectStore;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "od-rbq-"));
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    objects = await FsObjectStore.open(path.join(dir, "server-store"));
    const token = generateToken();
    tokenFile = path.join(dir, "token");
    writeFileSync(tokenFile, `${token}\n`);
    chmodSync(tokenFile, 0o600);
    let base = "";
    const app = createApi({
      sql,
      objects,
      kv: new MemoryKvStore(),
      config: { get publicUrl() { return base; }, rateLimitPerMinute: 100000, rbqRepositories: { [ID]: { token, prefix: `repositories/${ID}/` } } } as never,
    });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    endpoint = `${base}/api/rbq/${ID}`;
    execFileSync("cargo", ["build", "-q", "-p", "opendata-rbq"], { cwd: rust, stdio: "pipe" });
  }, 600000);
  afterAll(() => server?.close());

  // Async: the server runs in this process, so a blocking spawn would deadlock.
  const rbq = async (...args: string[]) => {
    try {
      const { stdout } = await promisify(execFile)(RBQ, ["repository", "--endpoint", endpoint, "--token-file", tokenFile, ...args], { encoding: "utf8", timeout: 60000 });
      return JSON.parse(stdout);
    } catch (error) {
      throw new Error(`rbq ${args.join(" ")} failed: ${(error as { stderr?: string }).stderr ?? error}`);
    }
  };

  it("describes, appends, lists and reads", async () => {
    expect((await rbq("describe"))).toMatchObject({ schema: "ragbaz.rbq-repository.v1", private: true, repository_id: ID });
    const file = path.join(dir, "envelope.json");
    writeFileSync(file, JSON.stringify({ schema: "opendata.message.v1", subject: "hej" }));
    expect((await rbq("append", "messages/v1/outbox/envelopes/20261123T000000.000Z-abcdefabcdef.json", "--file", file))).toMatchObject({ created: true });
    expect((await rbq("append", "messages/v1/outbox/envelopes/20261123T000000.000Z-abcdefabcdef.json", "--file", file))).toMatchObject({ created: false });
    const listed = (await rbq("list", "--prefix", "messages/"));
    expect(listed.objects).toHaveLength(1);
    const out = path.join(dir, "read-back.json");
    (await rbq("read", "messages/v1/outbox/envelopes/20261123T000000.000Z-abcdefabcdef.json", "--output", out));
    expect(readFileSync(out, "utf8")).toBe(readFileSync(file, "utf8"));
  });

  it("pushes a layer snapshot from one store and pulls it into another", async () => {
    const local = path.join(dir, "local-store");
    const snap = path.join(dir, "snap");
    execFileSync("mkdir", ["-p", `${snap}/tables`]);
    writeFileSync(path.join(snap, "tables/organisation.ndjson"), Array.from({ length: 4000 }, (_, i) => JSON.stringify({ orgnr: String(i) })).join("\n"));
    writeFileSync(path.join(snap, "meta.json"), '{"schema":"opendata.snapshot.v1"}');
    // rbq's push/pull accept its own layer names, so this round trip uses "agenda".
    execFileSync(path.join(rust, "target/debug/opendata-rbq"), ["publish", "--storage-root", local, "--dir", snap, "--layer", "agenda", "--label", "interop"]);
    const pushed = (await rbq("push", "--store", local, "--source-id", "opendata-test", "--source-name", "opendata test", "--layer", "agenda"));
    expect(pushed.complete).toBe(true);
    const other = path.join(dir, "other-store");
    const pulled = (await rbq("pull", "--store", other, "--source-id", "opendata-test", "--layer", "agenda"));
    expect(pulled.complete).toBe(true);
    expect((await rbq("sources")).sources.map((s: { id?: string; source_id?: string }) => s.id ?? s.source_id)).toContain("opendata-test");
  });
});
