import type { KvStore, Mailer, ObjectStore, SqlStore } from "@opendata/ports";

/** Everything the apps need, wired by a runtime composition root. */
export interface Services {
  sql: SqlStore;
  objects: ObjectStore;
  kv: KvStore;
  mailer?: Mailer;
  config: AppConfig;
}

export interface AppConfig {
  /** Public base URL, used in e-mail links. */
  publicUrl: string;
  /** Sender for alert/confirmation mail. */
  mailFrom?: { email: string; name?: string };
  /** Bearer tokens accepted by /api/rbq/{id} (rbq-repository.v1), keyed by endpoint id. */
  rbqRepositories?: Record<string, { token: string; prefix: string }>;
  /** Shared secret for operator endpoints (ingest triggers). */
  adminToken?: string;
  /** Requests per minute per client before 429. */
  rateLimitPerMinute?: number;
  /** Max GraphQL query depth. */
  maxDepth?: number;
}
