import { Watches } from "@opendata/mail";
import { RateLimiter } from "./ratelimit";
import type { Context } from "./resolvers";
import type { Services } from "./services";

export function watchesFor(services: Services): Watches | null {
  if (!services.mailer || !services.config.mailFrom) return null;
  return new Watches(services.sql, services.objects, { publicUrl: services.config.publicUrl, from: services.config.mailFrom });
}

/** Watch requests send mail to a third party: 5 per client per hour, per process/isolate. */
const watchLimiter = new RateLimiter(5, 10000, 3600_000);

export async function createWatch(c: Context, args: { email: string; kommun?: string; deso?: string; sniPrefix?: string }) {
  const watches = watchesFor(c.services);
  if (!watches) return { accepted: false, message: "mail is not configured on this server" };
  if (!watchLimiter.allow(c.clientId).ok) return { accepted: false, message: "too many watch requests; try again later" };
  return watches.create(args);
}
