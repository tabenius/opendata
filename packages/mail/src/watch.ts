/**
 * Area watches: "tell me about new workplaces in this kommun/DeSO (with this
 * SNI prefix)". Double opt-in: nothing but the confirmation mail is sent until
 * the link is opened. Mail goes through the outbox, never from a request.
 */
import type { SqlStore } from "@opendata/ports";
import { MessageLog } from "./messages";
import { OUTBOX } from "./outbox";

export interface WatchConfig {
  publicUrl: string;
  from: { email: string; name?: string };
  maxWatchesPerEmail?: number;
}

export interface WatchInput {
  email: string;
  kommun?: string | null;
  deso?: string | null;
  sniPrefix?: string | null;
}

function token(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const EMAIL = /^[^\s@<>()"',;:\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function matchClause(w: { kommun: string | null; deso: string | null; sni_prefix: string | null }) {
  const where: string[] = [];
  const params: string[] = [];
  if (w.kommun) {
    where.push("w.kommun = ?");
    params.push(w.kommun);
  }
  if (w.deso) {
    where.push("a.deso = ?");
    params.push(w.deso);
  }
  if (w.sni_prefix) {
    where.push("w.sni LIKE ?");
    params.push(`${w.sni_prefix}%`);
  }
  return { sql: where.join(" AND "), params };
}

export class Watches {
  private readonly log: MessageLog;
  constructor(
    private readonly sql: SqlStore,
    objects: ConstructorParameters<typeof MessageLog>[0],
    private readonly config: WatchConfig,
  ) {
    this.log = new MessageLog(objects);
  }

  /** Always answers the same way, whether or not the address is known. */
  async create(input: WatchInput): Promise<{ accepted: boolean; message: string }> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return { accepted: false, message: "invalid e-mail address" };
    if (!input.kommun && !input.deso) return { accepted: false, message: "give a kommun or a deso" };
    if (input.kommun && !/^\d{4}$/.test(input.kommun)) return { accepted: false, message: "kommun is a 4-digit code" };
    if (input.deso && !/^\d{4}[A-C]\d{4}$/.test(input.deso)) return { accepted: false, message: "invalid DeSO code" };
    if (input.sniPrefix && !/^\d{1,5}$/.test(input.sniPrefix)) return { accepted: false, message: "sniPrefix is 1-5 digits" };
    const count = await this.sql.first<{ c: number }>("SELECT count(*) AS c FROM watch WHERE email = ?", [email]);
    const accepted = { accepted: true, message: "If the address is valid, a confirmation e-mail is on its way." };
    if (Number(count?.c ?? 0) >= (this.config.maxWatchesPerEmail ?? 5)) return accepted;
    const id = crypto.randomUUID();
    const confirm = token();
    await this.sql.exec(
      "INSERT INTO watch (id, email, kommun, deso, sni_prefix, confirm_token, confirmed, created_at, unsubscribe_token) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
      [id, email, input.kommun ?? null, input.deso ?? null, input.sniPrefix ?? null, confirm, new Date().toISOString(), token()],
    );
    const link = `${this.config.publicUrl}/watch/confirm?token=${confirm}`;
    const what = [input.kommun && `kommun ${input.kommun}`, input.deso && `DeSO ${input.deso}`, input.sniPrefix && `SNI ${input.sniPrefix}*`].filter(Boolean).join(", ");
    await this.log.append(OUTBOX, {
      idempotency: `confirm-${id}`,
      from: this.config.from,
      to: [{ email }],
      subject: "Bekräfta bevakning / Confirm your watch",
      text: `Någon (förhoppningsvis du) vill bevaka nya arbetsställen i ${what}.\nBekräfta: ${link}\n\nSomeone (hopefully you) asked to watch new workplaces in ${what}.\nConfirm: ${link}\n\nIgnore this e-mail if it was not you; nothing more will be sent.`,
    });
    return accepted;
  }

  async confirm(confirmToken: string): Promise<boolean> {
    if (!/^[0-9a-f]{48}$/.test(confirmToken)) return false;
    const watch = await this.sql.first<{ id: string; kommun: string | null; deso: string | null; sni_prefix: string | null; confirmed: number }>(
      "SELECT id, kommun, deso, sni_prefix, confirmed FROM watch WHERE confirm_token = ?",
      [confirmToken],
    );
    if (!watch) return false;
    if (watch.confirmed) return true;
    // Seed with what exists today so alerts only cover genuinely new workplaces.
    const m = matchClause(watch);
    await this.sql.exec(
      `INSERT OR IGNORE INTO watch_seen (watch_id, cfar) SELECT ?, w.cfar FROM workplace w LEFT JOIN address a ON a.address_id = w.address_id WHERE ${m.sql}`,
      [watch.id, ...m.params],
    );
    await this.sql.exec("UPDATE watch SET confirmed = 1, last_checked_at = ? WHERE id = ?", [new Date().toISOString(), watch.id]);
    return true;
  }

  async unsubscribe(unsubscribeToken: string): Promise<boolean> {
    if (!/^[0-9a-f]{48}$/.test(unsubscribeToken)) return false;
    const watch = await this.sql.first<{ id: string }>("SELECT id FROM watch WHERE unsubscribe_token = ?", [unsubscribeToken]);
    if (!watch) return false;
    await this.sql.batch([
      { sql: "DELETE FROM watch_seen WHERE watch_id = ?", params: [watch.id] },
      { sql: "DELETE FROM watch WHERE id = ?", params: [watch.id] },
    ]);
    return true;
  }

  /** Queue one alert per confirmed watch with new matching workplaces. */
  async check(limitPerWatch = 50): Promise<{ watches: number; alerts: number }> {
    const watches = await this.sql.query<{ id: string; email: string; kommun: string | null; deso: string | null; sni_prefix: string | null; unsubscribe_token: string }>(
      "SELECT id, email, kommun, deso, sni_prefix, unsubscribe_token FROM watch WHERE confirmed = 1",
    );
    let alerts = 0;
    for (const watch of watches) {
      const m = matchClause(watch);
      const fresh = await this.sql.query<{ cfar: number; name: string | null; organisation: string | null; sni: string | null; visit_street: string | null; visit_town: string | null }>(
        `SELECT w.cfar, w.name, o.name AS organisation, w.sni, w.visit_street, w.visit_town FROM workplace w
         LEFT JOIN address a ON a.address_id = w.address_id LEFT JOIN organisation o ON o.orgnr = w.orgnr
         WHERE ${m.sql} AND NOT EXISTS (SELECT 1 FROM watch_seen s WHERE s.watch_id = ? AND s.cfar = w.cfar) ORDER BY w.cfar LIMIT ?`,
        [...m.params, watch.id, limitPerWatch],
      );
      if (fresh.length === 0) continue;
      const lines = fresh.map((w) => `- ${w.organisation ?? w.name ?? "?"}${w.sni ? ` (SNI ${w.sni})` : ""}, ${[w.visit_street, w.visit_town].filter(Boolean).join(", ")}`);
      const unsubscribe = `${this.config.publicUrl}/watch/unsubscribe?token=${watch.unsubscribe_token}`;
      await this.log.append(OUTBOX, {
        idempotency: `alert-${watch.id}-${fresh.map((w) => w.cfar).join(",")}`,
        from: this.config.from,
        to: [{ email: watch.email }],
        subject: `${fresh.length} nya arbetsställen / new workplaces`,
        text: `${lines.join("\n")}\n\nKälla: SCB, allmänna företagsregistret; Lantmäteriet.\nAvsluta bevakningen / unsubscribe: ${unsubscribe}`,
      });
      await this.sql.batch(fresh.map((w) => ({ sql: "INSERT OR IGNORE INTO watch_seen (watch_id, cfar) VALUES (?, ?)", params: [watch.id, w.cfar] })));
      await this.sql.exec("UPDATE watch SET last_checked_at = ? WHERE id = ?", [new Date().toISOString(), watch.id]);
      alerts++;
    }
    return { watches: watches.length, alerts };
  }
}
