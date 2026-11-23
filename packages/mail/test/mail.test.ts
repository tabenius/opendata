import { afterAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { MemoryObjectStore } from "@opendata/adapters-object/memory";
import { MemoryKvStore } from "@opendata/adapters-kv";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { Repository, fixtureDataset, migrations } from "@opendata/core";
import { CfEmailMailer, MemoryMailer, MessageLog, OUTBOX, ResendMailer, Watches, buildMime, canonicalJson, deliverOutbox } from "../src";
import { SmtpMailer } from "../src/smtp";

const from = { email: "alerts@opendata.example", name: "Öppna data" };

describe("MIME", () => {
  it("encodes UTF-8 headers and bodies and refuses header injection", () => {
    const raw = buildMime({ from, to: [{ email: "a@b.se" }], subject: "Hej då", text: "Åäö", html: "<p>Åäö</p>" }, { messageId: "x@y" });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain('From: "=?UTF-8?B?');
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(atob(raw.split("base64\r\n\r\n")[1]!.split("\r\n")[0]!)).toBe(String.fromCharCode(...new TextEncoder().encode("Åäö")));
    expect(() => buildMime({ from, to: [{ email: "a@b.se" }], subject: "x\r\nBcc: evil@x.se", text: "" }, { messageId: "x@y" })).toThrow();
  });
});

describe("mailers", () => {
  it("sends through Resend with idempotency keys", async () => {
    let seen: { headers: Headers; body: any } | undefined;
    const mailer = new ResendMailer("re_key", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({ id: "resend-1" });
    }) as typeof fetch);
    const r = await mailer.send({ from, to: [{ email: "a@b.se" }], subject: "s", text: "t", idempotencyKey: "k1" });
    expect(r.providerMessageId).toBe("resend-1");
    expect(seen!.headers.get("Idempotency-Key")).toBe("k1");
    expect(seen!.body.from).toBe("Öppna data <alerts@opendata.example>");
  });

  it("sends raw MIME through the Workers send_email binding, one envelope per recipient", async () => {
    const sent: { from: string; to: string; raw: string }[] = [];
    class EmailMessage {
      constructor(public from: string, public to: string, public raw: string) {}
    }
    const mailer = new CfEmailMailer({ send: async (m) => void sent.push(m as EmailMessage) }, EmailMessage, "opendata.example");
    await mailer.send({ from, to: [{ email: "a@b.se" }, { email: "c@d.se" }], subject: "s", text: "t" });
    expect(sent.map((s) => s.to)).toEqual(["a@b.se", "c@d.se"]);
    expect(sent[0]!.raw).toMatch(/^From: /);
    expect(mailer.capabilities().arbitraryRecipients).toBe(false);
  });

  const received: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, _s, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => (received.push(data), cb()));
    },
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("sends over SMTP", async () => {
    await new Promise<void>((r) => server.listen(2526, "127.0.0.1", () => r()));
    const mailer = new SmtpMailer({ host: "127.0.0.1", port: 2526, secure: false, allowInsecure: true });
    await mailer.send({ from, to: [{ email: "a@b.se" }], subject: "SMTP-test", text: "hej" });
    mailer.close();
    expect(received[0]).toContain("Subject: SMTP-test");
  });
});

describe("message log and outbox", () => {
  it("appends immutable canonical envelopes, dedupes retries, delivers once", async () => {
    const objects = new MemoryObjectStore();
    const log = new MessageLog(objects);
    const first = await log.append(OUTBOX, { idempotency: "k", from, to: [{ email: "a@b.se" }], subject: "s", text: "t", created_at: "2026-11-23T10:00:00.000Z" });
    const again = await log.append(OUTBOX, { idempotency: "k", from, to: [{ email: "a@b.se" }], subject: "s", text: "t", created_at: "2026-11-23T11:00:00.000Z" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(first.key).toMatch(/^messages\/v1\/outbox\/envelopes\/20261123T100000\.000Z-[0-9a-f]{12}\.json$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe('{"a":{"c":[3],"d":2},"b":1}');
    const mailer = new MemoryMailer();
    expect(await deliverOutbox(log, mailer, new MemoryKvStore())).toMatchObject({ delivered: 1 });
    expect(await deliverOutbox(log, mailer, new MemoryKvStore())).toMatchObject({ delivered: 0 });
    expect(mailer.sent).toHaveLength(1);
    expect(await log.pruneDelivered(OUTBOX, 30, new Date("2027-01-01"))).toBe(1);
  });

  it("retries failed deliveries with a cap", async () => {
    const log = new MessageLog(new MemoryObjectStore());
    await log.append(OUTBOX, { idempotency: "k", from, to: [{ email: "a@b.se" }], subject: "s", text: "t" });
    const kv = new MemoryKvStore();
    const broken = { name: "broken", capabilities: () => ({ arbitraryRecipients: true, attachments: false, maxMessageBytes: 1 }), send: async () => { throw new Error("down"); } };
    for (let i = 0; i < 8; i++) expect((await deliverOutbox(log, broken, kv)).failed).toBe(1);
    expect(await deliverOutbox(log, broken, kv)).toMatchObject({ failed: 0, gaveUp: 1 });
  });
});

describe("watches", () => {
  it("double opt-in, alerts only for new workplaces, unsubscribes", async () => {
    const sql = new SqliteSqlStore(":memory:");
    await migrate(sql, migrations);
    const repo = new Repository(sql);
    const d = fixtureDataset();
    await repo.upsertAddresses(d.addresses);
    await repo.upsertOrganisations(d.organisations);
    await repo.upsertWorkplaces(d.workplaces.slice(0, 6));
    const objects = new MemoryObjectStore();
    const watches = new Watches(sql, objects, { publicUrl: "https://od.example", from });
    const mailer = new MemoryMailer();
    const kv = new MemoryKvStore();
    const log = new MessageLog(objects);

    expect((await watches.create({ email: "bad", kommun: "1480" })).accepted).toBe(false);
    expect((await watches.create({ email: "Person@Example.se", kommun: "1480", sniPrefix: "4" })).accepted).toBe(true);
    await deliverOutbox(log, mailer, kv);
    expect(mailer.sent[0]!.to[0]!.email).toBe("person@example.se");
    const confirmToken = /token=([0-9a-f]{48})/.exec(mailer.sent[0]!.text)![1]!;

    expect((await watches.check()).alerts).toBe(0); // unconfirmed: nothing
    expect(await watches.confirm(confirmToken)).toBe(true);
    expect((await watches.check()).alerts).toBe(0); // existing workplaces are seeded, not alerted

    await repo.upsertWorkplaces(d.workplaces.slice(6)); // new ones arrive (incl. SNI 43210, 47110 starting with 4)
    expect((await watches.check()).alerts).toBe(1);
    await deliverOutbox(log, mailer, kv);
    const alert = mailer.sent[1]!;
    expect(alert.text).toMatch(/Elfirma Norr/);
    expect(alert.text).not.toMatch(/Anna Andersson/);
    expect((await watches.check()).alerts).toBe(0);

    const unsubscribeToken = /unsubscribe: .*token=([0-9a-f]{48})/.exec(alert.text)![1]!;
    expect(await watches.unsubscribe(unsubscribeToken)).toBe(true);
    expect(await sql.first("SELECT count(*) AS c FROM watch")).toEqual({ c: 0 });
  });
});

describe("outbox budget", () => {
  it("does not let exhausted envelopes starve newer mail", async () => {
    const log = new MessageLog(new MemoryObjectStore());
    const kv = new MemoryKvStore();
    for (let i = 0; i < 3; i++) {
      const ref = await log.append(OUTBOX, { idempotency: `old-${i}`, from, to: [{ email: "a@b.se" }], subject: "old", text: "t", created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
      await kv.put(`mail/attempts/${ref.sha12}`, "8");
    }
    await log.append(OUTBOX, { idempotency: "new", from, to: [{ email: "a@b.se" }], subject: "new", text: "t", created_at: "2026-11-23T00:00:00.000Z" });
    const mailer = new MemoryMailer();
    const report = await deliverOutbox(log, mailer, kv, { limit: 2 });
    expect(report).toMatchObject({ delivered: 1, gaveUp: 3 });
    expect(mailer.sent[0]!.subject).toBe("new");
  });
});
