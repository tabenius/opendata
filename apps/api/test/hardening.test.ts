import { describe, expect, it } from "vitest";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { MemoryKvStore } from "@opendata/adapters-kv";
import { MemoryMailer, MessageLog, OUTBOX, deliverOutbox } from "@opendata/mail";
import { parseObjectKey } from "@opendata/ports";
import { Repository, fixtureDataset, migrations } from "@opendata/core";
import { createApi } from "../src";

async function api(extra: Record<string, unknown> = {}) {
  const sql = new SqliteSqlStore(":memory:");
  await migrate(sql, migrations);
  const repo = new Repository(sql);
  const d = fixtureDataset();
  await repo.upsertAddresses(d.addresses);
  await repo.upsertOrganisations(d.organisations);
  await repo.upsertWorkplaces(d.workplaces);
  const objects = new MemoryObjectStore();
  const mailer = new MemoryMailer();
  const kv = new MemoryKvStore();
  const app = createApi({
    sql,
    objects,
    kv,
    mailer,
    config: { publicUrl: "https://od.example", mailFrom: { email: "alerts@od.example" }, rateLimitPerMinute: 1000, ...extra },
  });
  const gql = async (query: string, variables?: unknown, headers: Record<string, string> = {}) =>
    (await (await app.request("/graphql", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ query, variables }) })).json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
  return { app, sql, objects, mailer, kv, gql, d };
}

describe("response headers", () => {
  it("sends security headers everywhere and a CSP on HTML", async () => {
    const { app } = await api();
    const health = await app.request("/healthz");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    const html = await app.request("/watch/confirm?token=" + "a".repeat(48));
    expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("serves stored documents as sandboxed attachments", async () => {
    const { app, objects } = await api();
    await objects.put(parseObjectKey("annual-reports/5560360793/r.zip"), "PK");
    const res = await app.request("/files/annual-reports/5560360793/r.zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="r.zip"');
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("request limits", () => {
  it("bounds GraphQL bodies even without Content-Length", async () => {
    const { app } = await api();
    const big = JSON.stringify({ query: `{ sources { id } }`, padding: "x".repeat(20000) });
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(big)), c.close()) });
    const res = await app.request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("refuses very long URLs", async () => {
    const { app } = await api();
    expect((await app.request(`/graphql?query=${"x".repeat(9000)}`)).status).toBe(414);
  });
});

describe("input validation", () => {
  it("rejects malformed filters and cursors as user errors", async () => {
    const { gql } = await api();
    for (const q of [`{ organisations(filter: {sni: "%"}) { items { name } } }`, `{ organisations(filter: {kommun: "14"}) { items { name } } }`, `{ organisations(after: "bm9wZQ") { items { name } } }`, `{ area(deso: "x") { deso } }`]) {
      const r = await gql(q);
      expect(r.errors?.[0]?.extensions?.code, q).toBe("BAD_USER_INPUT");
    }
  });
});

describe("watch flow hardening", () => {
  it("needs a POST to confirm, supports one-click unsubscribe, and limits requests per client", async () => {
    const { app, gql, mailer, objects, kv, sql } = await api();
    const create = () => gql(`mutation { watchArea(email: "me@example.se", kommun: "1480") { accepted message } }`, undefined, { "cf-connecting-ip": "5.5.5.5" });
    expect((await create()).data.watchArea.accepted).toBe(true);
    await deliverOutbox(new MessageLog(objects), mailer, kv);
    const token = /token=([0-9a-f]{48})/.exec(mailer.sent[0]!.text)![1]!;

    // A link scanner opening the URL changes nothing.
    expect((await app.request(`/watch/confirm?token=${token}`)).status).toBe(200);
    expect(await sql.first("SELECT confirmed FROM watch")).toEqual({ confirmed: 0 });
    // The button posts the form.
    const form = new URLSearchParams({ token });
    expect((await app.request("/watch/confirm", { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(200);
    expect(await sql.first("SELECT confirmed FROM watch")).toEqual({ confirmed: 1 });

    const unsub = (await sql.first<{ unsubscribe_token: string }>("SELECT unsubscribe_token FROM watch"))!.unsubscribe_token;
    // RFC 8058: POST to the List-Unsubscribe URL.
    expect((await app.request(`/watch/unsubscribe?token=${unsub}`, { method: "POST", body: "List-Unsubscribe=One-Click" })).status).toBe(200);
    expect(await sql.first("SELECT count(*) AS c FROM watch")).toEqual({ c: 0 });

    for (let i = 0; i < 4; i++) await create();
    expect((await create()).data.watchArea).toMatchObject({ accepted: false, message: expect.stringMatching(/too many/) });
  });

  it("expires unconfirmed watches", async () => {
    const { sql, objects } = await api();
    const { Watches } = await import("@opendata/mail");
    const watches = new Watches(sql, objects, { publicUrl: "https://od.example", from: { email: "a@od.example" } });
    await watches.create({ email: "x@example.se", kommun: "1480" });
    expect(await watches.expireUnconfirmed(new Date(Date.now() + 49 * 3600_000))).toBe(1);
  });

  it("puts one-click unsubscribe headers on alerts", async () => {
    const { sql, objects, mailer, kv } = await api();
    const { Watches } = await import("@opendata/mail");
    const watches = new Watches(sql, objects, { publicUrl: "https://od.example", from: { email: "a@od.example" } });
    await watches.create({ email: "x@example.se", kommun: "1480" });
    await sql.exec("UPDATE watch SET confirmed = 1");
    await watches.check();
    await deliverOutbox(new MessageLog(objects), mailer, kv);
    const alert = mailer.sent.find((m) => m.subject.includes("nya"));
    expect(alert?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(alert?.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/od\.example\/watch\/unsubscribe\?token=/);
    void OUTBOX;
  });
});
