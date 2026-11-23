import type { Context } from "./resolvers";

/** Replaced in M6 by the outbox-backed implementation in @opendata/mail. */
export async function createWatch(c: Context, _args: { email: string; kommun?: string; deso?: string; sniPrefix?: string }) {
  void c;
  return { accepted: false, message: "mail is not configured on this server" };
}
