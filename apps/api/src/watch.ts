import { Watches } from "@opendata/mail";
import type { Context } from "./resolvers";
import type { Services } from "./services";

export function watchesFor(services: Services): Watches | null {
  if (!services.mailer || !services.config.mailFrom) return null;
  return new Watches(services.sql, services.objects, { publicUrl: services.config.publicUrl, from: services.config.mailFrom });
}

export async function createWatch(c: Context, args: { email: string; kommun?: string; deso?: string; sniPrefix?: string }) {
  const watches = watchesFor(c.services);
  if (!watches) return { accepted: false, message: "mail is not configured on this server" };
  return watches.create(args);
}
