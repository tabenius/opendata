import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { MemoryKvStore } from "@opendata/adapters-kv";
import { migrations } from "@opendata/core";
import { RepositoryClient, contract, generateToken, sha256Hex } from "@opendata/rbq";
import { parseObjectKey } from "@opendata/ports";
import { createApi, validateRepositories } from "../src";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

async function server(extra: { writable?: boolean; quotaBytes?: number } = {}) {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  const objects = new MemoryObjectStore();
  const token = generateToken();
  const app = createApi({
    sql,
    objects,
    kv: new MemoryKvStore(),
    config: { publicUrl: "http://127.0.0.1", rateLimitPerMinute: 10000, rbqRepositories: { [ID]: { token, prefix: `repositories/${ID}/`, ...extra } } },
  });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  return { app, objects, token, client: new RepositoryClient(`http://127.0.0.1/api/rbq/${ID}`, token, fetcher), fetcher };
}

describe("rbq-repository.v1 server", () => {
  it("describes, appends immutably, lists with paging and reads hash-verified", async () => {
    const { client, objects } = await server();
    expect(await client.describe()).toMatchObject({ schema: contract.contract, private: true, repository_id: ID });
    const a = await client.append("agenda/v1/x/one", "first");
    expect(a.created).toBe(true);
    expect((await client.append("agenda/v1/x/one", "first")).created).toBe(false);
    await expect(client.append("agenda/v1/x/one", "different")).rejects.toMatchObject({ status: 409 });
    for (const k of ["b", "c", "d"]) await client.append(`agenda/v1/x/${k}`, k);
    const page1 = await client.list("agenda/", undefined, 2);
    expect(page1.objects.map((o) => o.key)).toEqual(["agenda/v1/x/b", "agenda/v1/x/c"]);
    const page2 = await client.list("agenda/", page1.next_after!, 2);
    expect(page2.objects.map((o) => o.key)).toEqual(["agenda/v1/x/d", "agenda/v1/x/one"]);
    expect(page2.next_after).toBeNull();
    expect(page1.objects[0]!.sha256).toBe(sha256Hex(new TextEncoder().encode("b")));
    expect(new TextDecoder().decode(await client.read("agenda/v1/x/one"))).toBe("first");
    // Stored inside the repository's namespace only.
    expect((await objects.head(parseObjectKey(`repositories/${ID}/agenda/v1/x/one`))).size).toBe(5);
  });

  it("follows the contract's error statuses", async () => {
    const { fetcher, token } = await server({ quotaBytes: 10 });
    const req = (path: string, init: RequestInit = {}, auth = `Bearer ${token}`) => fetcher(`http://127.0.0.1/api/rbq/${ID}${path}`, { ...init, headers: { Authorization: auth } });
    expect((await req("", {}, "Bearer rbm_" + "0".repeat(64))).status).toBe(401);
    expect((await fetcher("http://127.0.0.1/api/rbq/not-a-uuid")).status).toBe(404);
    expect((await req("/objects/missing")).status).toBe(404);
    expect((await req("/objects/a%20b", { method: "PUT", body: "x" })).status).toBe(404);
    expect((await req("/objects/big", { method: "PUT", body: new Uint8Array(contract.limits.object_bytes + 1) })).status).toBe(413);
    expect((await req("/objects/q1", { method: "PUT", body: "123456" })).status).toBe(201);
    expect((await req("/objects/q2", { method: "PUT", body: "123456" })).status).toBe(409); // quota
    expect((await req("/objects?limit=101")).status).toBe(400);
  });

  it("refuses read-only appends and unsafe namespaces", async () => {
    const { fetcher, token } = await server({ writable: false });
    expect((await fetcher(`http://127.0.0.1/api/rbq/${ID}/objects/k`, { method: "PUT", body: "x", headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    expect(() => validateRepositories({ [ID]: { token, prefix: "" } })).toThrow(/prefix/);
    expect(() => validateRepositories({ [ID]: { token, prefix: "opendata/" } })).toThrow(/reserved/);
    expect(() => validateRepositories({ [ID]: { token: "nope", prefix: "r/" } })).toThrow(/token/);
  });
});
