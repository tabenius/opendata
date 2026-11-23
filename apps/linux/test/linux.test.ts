import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, readSecretFile } from "../src/config";
import { compose } from "../src/compose";
import { parseArgs } from "../src/cli";
import { createApi } from "@opendata/api";

const tmp = () => mkdtempSync(path.join(tmpdir(), "od-linux-"));

describe("linux configuration", () => {
  it("layers defaults, file and overrides; resolves paths against the file", () => {
    const dir = tmp();
    const file = path.join(dir, "c.toml");
    writeFileSync(file, `data_dir = "data"\n[kv]\ntype = "memory"\n[limits]\nrate_per_minute = 5\n`);
    const { config } = loadConfig({ configPath: file, overrides: { listen: "0.0.0.0:1" }, env: { XDG_CONFIG_HOME: dir } });
    expect(config.data_dir).toBe(path.join(dir, "data"));
    expect(config.sql.file).toBe(path.join(dir, "data", "opendata.sqlite"));
    expect(config.kv.type).toBe("memory");
    expect(config.limits).toEqual({ rate_per_minute: 5, max_depth: 8 });
    expect(config.listen).toBe("0.0.0.0:1");
  });

  it("rejects unknown keys", () => {
    const dir = tmp();
    const file = path.join(dir, "c.toml");
    writeFileSync(file, `colour = "blue"\n`);
    expect(() => loadConfig({ configPath: file, env: { XDG_CONFIG_HOME: dir } })).toThrow(/unknown configuration key colour/);
    writeFileSync(file, `[kv]\npassword = "x"\n`);
    expect(() => loadConfig({ configPath: file, env: { XDG_CONFIG_HOME: dir } })).toThrow(/kv.password/);
  });

  it("refuses readable secret files", () => {
    const dir = tmp();
    const secret = path.join(dir, "s");
    writeFileSync(secret, "hunter2\n");
    chmodSync(secret, 0o644);
    expect(() => readSecretFile(secret)).toThrow(/chmod 600/);
    chmodSync(secret, 0o600);
    expect(readSecretFile(secret)).toBe("hunter2");
  });

  it("composes fs + sqlite + sqlite-kv and serves", async () => {
    const dir = tmp();
    const { config } = loadConfig({ overrides: { data_dir: dir }, env: { XDG_CONFIG_HOME: dir } });
    const services = await compose(config);
    expect([services.objects.name, services.sql.name, services.kv.name]).toEqual(["fs", "sqlite", "sqlite"]);
    const res = await createApi(services).request("/healthz");
    expect(await res.json()).toMatchObject({ ok: true, objects: "fs" });
    await services.sql.close();
  });

  it("parses flags", () => {
    expect(parseArgs(["ingest", "scb", "--kommun", "1480", "--dry", "--x=y"])).toEqual({ positional: ["ingest", "scb"], flags: { kommun: "1480", dry: true, x: "y" } });
  });
});

describe("linux client identity", () => {
  it("ignores X-Real-IP unless a loopback proxy is trusted", async () => {
    const { linuxClientId } = await import("../src/client");
    const ctx = (peer: string, real?: string) => ({ env: { incoming: { socket: { remoteAddress: peer } } }, req: { header: (n: string) => (n === "x-real-ip" ? real : undefined) } }) as never;
    expect(linuxClientId(false)(ctx("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
    expect(linuxClientId(true)(ctx("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
    expect(linuxClientId(true)(ctx("127.0.0.1", "1.2.3.4"))).toBe("1.2.3.4");
  });
});
