/** Deliver outbox envelopes that have no receipt yet; at-least-once, idempotent by digest. */
import type { KvStore, Mailer } from "@opendata/ports";
import { MessageLog } from "./messages";

export const OUTBOX = "outbox";
const MAX_ATTEMPTS = 8;

export interface DeliveryReport {
  delivered: number;
  failed: number;
  gaveUp: number;
  pending: number;
}

export async function deliverOutbox(log: MessageLog, mailer: Mailer, kv: KvStore, options: { limit?: number } = {}): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, failed: 0, gaveUp: 0, pending: 0 };
  let budget = options.limit ?? 100;
  for (const ref of await log.list(OUTBOX)) {
    if (await log.receipt(ref)) continue;
    // Exhausted envelopes are skipped before they can use up the budget.
    const attemptsKey = `mail/attempts/${ref.sha12}`;
    const attempts = Number((await kv.getText(attemptsKey)) ?? 0);
    if (attempts >= MAX_ATTEMPTS) {
      report.gaveUp++;
      continue;
    }
    if (budget-- <= 0) {
      report.pending++;
      continue;
    }
    const envelope = await log.read(ref);
    try {
      const receipt = await mailer.send({
        from: envelope.from,
        to: envelope.to,
        subject: envelope.subject,
        text: envelope.text,
        html: envelope.html,
        idempotencyKey: envelope.idempotency,
        headers: { "X-Opendata-Message": ref.sha12 },
      });
      await log.markDelivered(ref, { provider: receipt.provider, provider_message_id: receipt.providerMessageId, delivered_at: receipt.acceptedAt });
      await kv.delete(attemptsKey);
      report.delivered++;
    } catch (error) {
      await kv.put(attemptsKey, String(attempts + 1), { ttlSeconds: 7 * 86400 });
      console.error(`mail delivery failed for ${ref.sha12}:`, error instanceof Error ? error.message : error);
      report.failed++;
    }
  }
  return report;
}
