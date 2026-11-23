import type { Mailer } from "@opendata/ports";
import type { Env } from "./env";

/** Filled in M6 (Cloudflare Email binding, Resend). */
export function createMailer(_env: Env): Mailer | undefined {
  return undefined;
}
