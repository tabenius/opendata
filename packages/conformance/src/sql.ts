import { describe, expect, it } from "vitest";
import type { SqlStore } from "@opendata/ports";

export function sqlStoreConformance(name: string, make: () => Promise<SqlStore>) {
  describe(`SqlStore conformance: ${name}`, () => {
    const setup = async () => {
      const sql = await make();
      await sql.script("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, n REAL, b BLOB);\nCREATE INDEX t_n ON t(n);");
      return sql;
    };

    it("is the SQLite dialect", async () => {
      expect((await make()).capabilities().dialect).toBe("sqlite");
    });

    it("binds parameters and reads rows", async () => {
      const sql = await setup();
      const r = await sql.exec("INSERT INTO t (name, n) VALUES (?, ?)", ["a", 1.5]);
      expect(r.changes).toBe(1);
      await sql.exec("INSERT INTO t (name, n) VALUES (?, ?)", ["b", null]);
      expect(await sql.query("SELECT name, n FROM t ORDER BY name")).toEqual([
        { name: "a", n: 1.5 },
        { name: "b", n: null },
      ]);
      expect(await sql.first<{ c: number }>("SELECT count(*) AS c FROM t")).toEqual({ c: 2 });
      expect(await sql.first("SELECT * FROM t WHERE name = ?", ["zz"])).toBeNull();
    });

    it("runs batches atomically", async () => {
      const sql = await setup();
      await sql.batch([
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["x"] },
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["y"] },
      ]);
      await expect(
        sql.batch([
          { sql: "INSERT INTO t (name) VALUES (?)", params: ["z"] },
          { sql: "INSERT INTO t (name) VALUES (?)", params: ["x"] },
        ]),
      ).rejects.toMatchObject({ kind: "AlreadyExists" });
      expect((await sql.query<{ name: string }>("SELECT name FROM t ORDER BY name")).map((r) => r.name)).toEqual(["x", "y"]);
    });

    it("supports upserts and FTS5", async () => {
      const sql = await setup();
      await sql.exec("INSERT INTO t (name, n) VALUES ('u', 1) ON CONFLICT(name) DO UPDATE SET n = excluded.n");
      await sql.exec("INSERT INTO t (name, n) VALUES ('u', 2) ON CONFLICT(name) DO UPDATE SET n = excluded.n");
      expect(await sql.first("SELECT n FROM t WHERE name='u'")).toEqual({ n: 2 });
      await sql.script("CREATE VIRTUAL TABLE f USING fts5(name, tokenize='unicode61 remove_diacritics 2');");
      await sql.exec("INSERT INTO f (name) VALUES (?)", ["Göteborgs Kaffe AB"]);
      expect(await sql.query("SELECT name FROM f WHERE f MATCH ?", ["goteborgs*"])).toHaveLength(1);
    });

    it("maps constraint violations to AlreadyExists", async () => {
      const sql = await setup();
      await sql.exec("INSERT INTO t (name) VALUES ('dup')");
      await expect(sql.exec("INSERT INTO t (name) VALUES ('dup')")).rejects.toMatchObject({ kind: "AlreadyExists" });
    });
  });
}
