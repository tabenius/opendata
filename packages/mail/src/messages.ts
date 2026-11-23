/**
 * Messages as immutable rbq objects (doc/RBQ-COMPAT.md §5):
 *   messages/v1/<channel>/envelopes/<stamp>-<sha12>.json   canonical JSON, <= 256 KiB
 *   messages/v1/<channel>/receipts/<sha12>.json            delivery receipt
 * Appending the same envelope twice is an identical retry. Envelopes and
 * receipts are plain objects, so `rbq repository push/pull` carries them.
 */
import { isStorageError, listAll, parseObjectKey, utf8, type ObjectStore } from "@opendata/ports";
import { MAX_OBJECT_BYTES, sha256Hex, stamp } from "@opendata/rbq";

export const MESSAGE_SCHEMA = "opendata.message.v1";

export interface Envelope {
  schema: typeof MESSAGE_SCHEMA;
  channel: string;
  created_at: string;
  idempotency: string;
  to: { email: string; name?: string }[];
  from: { email: string; name?: string };
  subject: string;
  text: string;
  html?: string;
  /** Attachments are separate objects, referenced by key and digest. */
  attachments?: { object_key: string; sha256: string; filename: string; content_type: string }[];
}

export interface MessageRef {
  key: string;
  sha12: string;
  channel: string;
}

export interface Receipt {
  schema: "opendata.receipt.v1";
  envelope: string;
  provider: string;
  provider_message_id?: string;
  delivered_at: string;
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function validateChannel(channel: string) {
  if (!/^[a-z0-9-]{1,32}$/.test(channel)) throw new TypeError("channel must be 1..32 of a-z, 0-9, '-'");
}

export class MessageLog {
  constructor(private readonly objects: ObjectStore) {}

  async append(channel: string, envelope: Omit<Envelope, "schema" | "channel" | "created_at"> & { created_at?: string }): Promise<MessageRef & { created: boolean }> {
    validateChannel(channel);
    const full: Envelope = { schema: MESSAGE_SCHEMA, channel, created_at: envelope.created_at ?? new Date().toISOString(), ...envelope } as Envelope;
    // The digest covers content and idempotency key, not the timestamp, so retries dedupe.
    const sha = sha256Hex(new TextEncoder().encode(canonicalJson({ ...full, created_at: undefined })));
    const sha12 = sha.slice(0, 12);
    const existing = await this.find(channel, sha12);
    if (existing) return { ...existing, created: false };
    const bytes = new TextEncoder().encode(canonicalJson(full));
    if (bytes.length > MAX_OBJECT_BYTES) throw new RangeError("envelope exceeds 256 KiB; store large parts as attachments");
    const key = `messages/v1/${channel}/envelopes/${stamp(new Date(full.created_at))}-${sha12}.json`;
    const outcome = await this.objects.putIfAbsent(parseObjectKey(key), bytes);
    return { key, sha12, channel, created: outcome.created };
  }

  private async find(channel: string, sha12: string): Promise<MessageRef | null> {
    for await (const meta of listAll(this.objects, `messages/v1/${channel}/envelopes/`)) if (meta.key.endsWith(`-${sha12}.json`)) return { key: meta.key, sha12, channel };
    return null;
  }

  async list(channel: string): Promise<MessageRef[]> {
    validateChannel(channel);
    const refs: MessageRef[] = [];
    for await (const meta of listAll(this.objects, `messages/v1/${channel}/envelopes/`)) {
      const sha12 = /-([0-9a-f]{12})\.json$/.exec(meta.key)?.[1];
      if (sha12) refs.push({ key: meta.key, sha12, channel });
    }
    return refs;
  }

  async read(ref: MessageRef): Promise<Envelope> {
    const envelope = JSON.parse(utf8(await this.objects.get(parseObjectKey(ref.key)))) as Envelope;
    if (envelope.schema !== MESSAGE_SCHEMA || envelope.channel !== ref.channel) throw new TypeError(`${ref.key} is not a ${MESSAGE_SCHEMA} envelope`);
    return envelope;
  }

  private receiptKey(ref: MessageRef) {
    return parseObjectKey(`messages/v1/${ref.channel}/receipts/${ref.sha12}.json`);
  }

  async receipt(ref: MessageRef): Promise<Receipt | null> {
    try {
      return JSON.parse(utf8(await this.objects.get(this.receiptKey(ref)))) as Receipt;
    } catch (error) {
      if (isStorageError(error, "NotFound")) return null;
      throw error;
    }
  }

  async markDelivered(ref: MessageRef, receipt: Omit<Receipt, "schema" | "envelope">): Promise<void> {
    await this.objects.putIfAbsent(this.receiptKey(ref), canonicalJson({ schema: "opendata.receipt.v1", envelope: ref.key, ...receipt }));
  }

  /**
   * Administrative clean-up of delivered messages older than `days` (they hold
   * e-mail addresses). Deletion is local; rbq never propagates deletes.
   */
  async pruneDelivered(channel: string, days: number, now = new Date()): Promise<number> {
    let removed = 0;
    for (const ref of await this.list(channel)) {
      const receipt = await this.receipt(ref);
      if (!receipt || now.getTime() - Date.parse(receipt.delivered_at) < days * 86400_000) continue;
      await this.objects.delete(parseObjectKey(ref.key));
      await this.objects.delete(this.receiptKey(ref));
      removed++;
    }
    return removed;
  }
}

export const sha12Of = (sha: string) => sha.slice(0, 12);
