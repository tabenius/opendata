import { validateMessage, type MailCapabilities, type Mailer, type OutboundMessage, type SendReceipt } from "@opendata/ports";
import { buildMime } from "./mime";

/** Collects messages; the test runtime and `mail.type = "log"`. */
export class MemoryMailer implements Mailer {
  readonly name = "memory";
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly log?: (message: OutboundMessage) => void) {}
  capabilities(): MailCapabilities {
    return { arbitraryRecipients: true, attachments: true, maxMessageBytes: 25 * 1024 * 1024 };
  }
  async send(message: OutboundMessage): Promise<SendReceipt> {
    validateMessage(message);
    this.sent.push(message);
    this.log?.(message);
    return { provider: this.name, providerMessageId: `memory-${this.sent.length}`, acceptedAt: new Date().toISOString() };
  }
}

/** Resend HTTP API (Workers and Node alike). */
export class ResendMailer implements Mailer {
  readonly name = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = "https://api.resend.com/emails",
  ) {
    if (!apiKey) throw new TypeError("Resend API key is required");
  }
  capabilities(): MailCapabilities {
    return { arbitraryRecipients: true, attachments: true, maxMessageBytes: 40 * 1024 * 1024 };
  }
  async send(message: OutboundMessage): Promise<SendReceipt> {
    validateMessage(message);
    const fmt = (a: { email: string; name?: string }) => (a.name ? `${a.name} <${a.email}>` : a.email);
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: fmt(message.from),
        to: message.to.map(fmt),
        subject: message.subject,
        text: message.text,
        html: message.html,
        reply_to: message.replyTo ? fmt(message.replyTo) : undefined,
        headers: message.headers,
        attachments: message.attachments?.map((a) => ({ filename: a.filename, content: btoa(String.fromCharCode(...a.content)), content_type: a.contentType })),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Resend refused the message (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { id?: string };
    return { provider: this.name, providerMessageId: body.id, acceptedAt: new Date().toISOString() };
  }
}

/** Workers `send_email` binding. Takes the EmailMessage class from `cloudflare:email`. */
export interface SendEmailBinding {
  send(message: unknown): Promise<unknown>;
}
export type EmailMessageCtor = new (from: string, to: string, raw: string) => unknown;

export class CfEmailMailer implements Mailer {
  readonly name = "cf-email";
  constructor(
    private readonly binding: SendEmailBinding,
    private readonly EmailMessage: EmailMessageCtor,
    private readonly domain: string,
    private readonly verifiedOnly = true,
  ) {}
  capabilities(): MailCapabilities {
    // Email Routing's binding delivers to verified destination addresses only.
    return { arbitraryRecipients: !this.verifiedOnly, attachments: true, maxMessageBytes: 25 * 1024 * 1024 };
  }
  async send(message: OutboundMessage): Promise<SendReceipt> {
    const messageId = `${crypto.randomUUID()}@${this.domain}`;
    const raw = buildMime(message, { messageId });
    // One envelope per recipient: the binding takes a single RCPT TO.
    for (const to of message.to) await this.binding.send(new this.EmailMessage(message.from.email, to.email, raw));
    return { provider: this.name, providerMessageId: messageId, acceptedAt: new Date().toISOString() };
  }
}
