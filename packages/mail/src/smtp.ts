/** SMTP via nodemailer. Linux only (Workers block outbound port 25). */
import nodemailer from "nodemailer";
import { validateMessage, type MailCapabilities, type Mailer, type OutboundMessage, type SendReceipt } from "@opendata/ports";

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (465). Otherwise STARTTLS is required unless allowInsecure. */
  secure: boolean;
  user?: string;
  password?: string;
  /** Only for local test servers. */
  allowInsecure?: boolean;
}

export class SmtpMailer implements Mailer {
  readonly name = "smtp";
  private readonly transport: nodemailer.Transporter;
  constructor(config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && !config.allowInsecure,
      ignoreTLS: Boolean(config.allowInsecure),
      auth: config.user ? { user: config.user, pass: config.password } : undefined,
    });
  }
  capabilities(): MailCapabilities {
    return { arbitraryRecipients: true, attachments: true, maxMessageBytes: 25 * 1024 * 1024 };
  }
  async send(message: OutboundMessage): Promise<SendReceipt> {
    validateMessage(message);
    const info = await this.transport.sendMail({
      from: message.from.name ? { name: message.from.name, address: message.from.email } : message.from.email,
      to: message.to.map((t) => (t.name ? { name: t.name, address: t.email } : t.email)),
      replyTo: message.replyTo?.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: message.headers,
      attachments: message.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
    });
    return { provider: this.name, providerMessageId: info.messageId, acceptedAt: new Date().toISOString() };
  }
  close() {
    this.transport.close();
  }
}
