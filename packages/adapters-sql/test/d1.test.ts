import { afterAll, describe, expect, it } from "vitest";
import { sqlStoreConformance } from "@opendata/conformance";
import { disposeMiniflare, miniflare } from "@opendata/conformance/miniflare";
import { D1SqlStore, migrate, type D1DatabaseLike } from "../src";

let n = 0;
/** D1 has one database per binding; isolate tests by table-name suffix via a fresh schema each time. */
sqlStoreConformance("d1 (miniflare)", async () => {
  const db = (await miniflare().getD1Database("DB")) as unknown as D1DatabaseLike;
  const suffix = `_${++n}`;
  const rename = (sql: string) => sql.replace(/\b(t|f|t_n)\b(?=[\s(;]|$)/g, (m) => `${m}${suffix}`);
  const store = new D1SqlStore(db);
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "batch") return (s: { sql: string; params?: unknown[] }[]) => target.batch(s.map((x) => ({ ...x, sql: rename(x.sql) })) as never);
      if (["query", "first", "exec", "script"].includes(String(prop))) return (sql: string, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).call(target, rename(sql), ...rest);
      return value.bind(target);
    },
  });
});

describe("D1 migrations", () => {
  it("applies the project schema on D1", async () => {
    const db = (await miniflare().getD1Database("DB")) as unknown as D1DatabaseLike;
    const sql = new D1SqlStore(db);
    const { migrations } = await import("@opendata/schema");
    const report = await migrate(sql, migrations);
    expect(report.current).toContain("0001_init");
    expect(await sql.first("SELECT count(*) AS c FROM organisation")).toEqual({ c: 0 });
  });
});

afterAll(disposeMiniflare);
