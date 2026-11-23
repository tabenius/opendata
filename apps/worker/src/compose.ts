/** The Workers composition root: bindings -> adapters -> Services. */
import { R2ObjectStore } from "@opendata/adapters-object";
import { D1SqlStore, migrate } from "@opendata/adapters-sql";
import { CfKvStore } from "@opendata/adapters-kv";
import { migrations } from "@opendata/core";
import type { Services } from "@opendata/api";
import type { Env } from "./env";
import { createMailer } from "./mail";

let migrated: Promise<unknown> | undefined;

export function compose(env: Env): Services {
  const sql = new D1SqlStore(env.DB);
  // Once per isolate; migrations are idempotent and checksummed.
  migrated ??= migrate(sql, migrations).catch((error) => {
    migrated = undefined;
    throw error;
  });
  return {
    sql,
    objects: new R2ObjectStore(env.OBJECTS),
    kv: new CfKvStore(env.CACHE),
    mailer: createMailer(env),
    config: {
      publicUrl: env.PUBLIC_URL,
      mailFrom: env.MAIL_FROM ? { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME } : undefined,
      adminToken: env.ADMIN_TOKEN,
      rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
      rbqRepositories: env.RBQ_REPOSITORIES ? JSON.parse(env.RBQ_REPOSITORIES) : undefined,
    },
  };
}

export function ready(): Promise<unknown> {
  return migrated ?? Promise.resolve();
}
