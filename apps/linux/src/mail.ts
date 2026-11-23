import type { Mailer } from "@opendata/ports";
import { MemoryMailer, ResendMailer } from "@opendata/mail";
import { SmtpMailer } from "@opendata/mail/smtp";
import { readSecretFile, type Config } from "./config";

export function createMailer(config: Config): Mailer | undefined {
  const m = config.mail;
  switch (m.type) {
    case "none":
      return undefined;
    case "log":
      return new MemoryMailer((message) => console.error(`[mail] to=${message.to.map((t) => t.email).join(",")} subject=${JSON.stringify(message.subject)}\n${message.text}`));
    case "resend":
      if (!m.api_key_file) throw new Error("mail.type = resend needs api_key_file");
      return new ResendMailer(readSecretFile(m.api_key_file));
    case "smtp":
      if (!m.host) throw new Error("mail.type = smtp needs host");
      return new SmtpMailer({
        host: m.host,
        port: m.port ?? 587,
        secure: m.secure ?? m.port === 465,
        user: m.user,
        password: m.password_file ? readSecretFile(m.password_file) : undefined,
      });
  }
}
