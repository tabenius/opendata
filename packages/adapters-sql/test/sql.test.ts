import { describe, expect, it } from "vitest";
import { sqlStoreConformance } from "@opendata/conformance";
import { SqliteSqlStore } from "../src/sqlite";
import { migrate, splitStatements } from "../src";

sqlStoreConformance("sqlite", async () => new SqliteSqlStore(":memory:"));

describe("migrations", () => {
  it("applies once and refuses edited migrations", async () => {
    const sql = new SqliteSqlStore(":memory:");
    const m = [{ id: "0001_a", sql: "CREATE TABLE a (x INTEGER);" }];
    expect((await migrate(sql, m)).applied).toEqual(["0001_a"]);
    expect((await migrate(sql, m)).applied).toEqual([]);
    await expect(migrate(sql, [{ id: "0001_a", sql: "CREATE TABLE a (y INTEGER);" }])).rejects.toThrow(/changed/);
  });

  it("exports a consistent file", async () => {
    const sql = new SqliteSqlStore(":memory:");
    await sql.script("CREATE TABLE a (x); INSERT INTO a VALUES (1);");
    const file = await sql.exportFile();
    expect(new TextDecoder().decode(file.slice(0, 15))).toBe("SQLite format 3");
    expect(file.length % 4096).toBe(0);
  });

  it("splits scripts on semicolons outside quotes", () => {
    expect(splitStatements("-- c\nCREATE TABLE a (x TEXT DEFAULT ';');\nINSERT INTO a VALUES ('a;b');")).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT ';');",
      "INSERT INTO a VALUES ('a;b');",
    ]);
  });
});
