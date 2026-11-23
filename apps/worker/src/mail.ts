import { EmailMessage } from "cloudflare:email";
import type { Mailer } from "@opendata/ports";
import { CfEmailMailer, ResendMailer, type EmailMessageCtor } from "@opendata/mail";
import type { Env } from "./env";

/** Resend when a key is set; otherwise the send_email binding (verified destinations only). */
export function createMailer(env: Env): Mailer | undefined {
  if (env.RESEND_API_KEY) return new ResendMailer(env.RESEND_API_KEY);
  if (env.EMAIL && env.MAIL_FROM) return new CfEmailMailer(env.EMAIL, EmailMessage as unknown as EmailMessageCtor, env.MAIL_FROM.split("@")[1] ?? "localhost");
  return undefined;
}
