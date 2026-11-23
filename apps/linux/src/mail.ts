import type { Mailer } from "@opendata/ports";
import type { Config } from "./config";

/** Filled in M6 with the SMTP/Resend adapters. */
export function createMailer(config: Config): Mailer | undefined {
  if (config.mail.type === "none") return undefined;
  throw new Error(`mail.type = ${config.mail.type} is not available yet`);
}
