import type { R2BucketLike } from "@opendata/adapters-object";
import type { D1DatabaseLike } from "@opendata/adapters-sql";
import type { KvNamespaceLike } from "@opendata/adapters-kv";

export interface Env {
  OBJECTS: R2BucketLike;
  DB: D1DatabaseLike;
  CACHE: KvNamespaceLike;
  EMAIL?: { send(message: unknown): Promise<void> };
  PUBLIC_URL: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  SNAPSHOT_LABEL?: string;
  ADMIN_TOKEN?: string;
  RESEND_API_KEY?: string;
  RBQ_REPOSITORIES?: string;
}
