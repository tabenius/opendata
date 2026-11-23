import { afterAll } from "vitest";
import { kvStoreConformance } from "@opendata/conformance";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { MemoryKvStore } from "../src/memory";
import { SqliteKvStore } from "../src/sqlite";
import { RedisKvStore } from "../src/redis";

kvStoreConformance("memory", async () => new MemoryKvStore());
kvStoreConformance("sqlite", async () => new SqliteKvStore(new SqliteSqlStore(":memory:")));

const url = process.env.REDIS_URL;
if (url) {
  const opened: RedisKvStore[] = [];
  kvStoreConformance("redis", async () => {
    const store = RedisKvStore.connect(url, `test-${crypto.randomUUID()}:`);
    opened.push(store);
    return store;
  });
  afterAll(async () => {
    await Promise.all(opened.map((s) => s.close()));
  });
}
