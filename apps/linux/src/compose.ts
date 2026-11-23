/** The Linux composition root: config -> adapters -> Services. */
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { FsObjectStore } from "@opendata/adapters-object/fs";
import { S3ObjectStore } from "@opendata/adapters-object";
import { SqliteSqlStore } from "@opendata/adapters-sql/sqlite";
import { migrate } from "@opendata/adapters-sql";
import { MemoryKvStore, SqliteKvStore } from "@opendata/adapters-kv";
import { RedisKvStore } from "@opendata/adapters-kv/redis";
import type { KvStore, ObjectStore } from "@opendata/ports";
import type { Services } from "@opendata/api";
import { migrations } from "@opendata/core";
import { readSecretFile, type Config } from "./config";
import { createMailer } from "./mail";

export async function openObjects(config: Config): Promise<ObjectStore> {
  if (config.objects.type === "s3") {
    const o = config.objects;
    if (!o.endpoint || !o.bucket || !o.access_key_id_file || !o.secret_access_key_file) throw new Error("objects.type = s3 needs endpoint, bucket, access_key_id_file, secret_access_key_file");
    return new S3ObjectStore({
      endpoint: o.endpoint,
      bucket: o.bucket,
      region: o.region,
      root: o.prefix,
      accessKeyId: readSecretFile(o.access_key_id_file),
      secretAccessKey: readSecretFile(o.secret_access_key_file),
    });
  }
  return FsObjectStore.open(config.objects.root);
}

export async function openKv(config: Config, sql: SqliteSqlStore): Promise<KvStore> {
  if (config.kv.type === "redis") {
    const url = config.kv.url_file ? readSecretFile(config.kv.url_file) : config.kv.url;
    if (!url) throw new Error("kv.type = redis needs url or url_file");
    return RedisKvStore.connect(url, config.kv.namespace ?? "opendata:");
  }
  if (config.kv.type === "memory") return new MemoryKvStore();
  return new SqliteKvStore(sql);
}

export async function compose(config: Config): Promise<Services & { sql: SqliteSqlStore }> {
  mkdirSync(config.data_dir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(config.sql.file), { recursive: true, mode: 0o700 });
  const sql = new SqliteSqlStore(config.sql.file);
  chmodSync(config.sql.file, 0o600);
  await migrate(sql, migrations);
  const objects = await openObjects(config);
  const kv = await openKv(config, sql);
  const rbqRepositories = Object.fromEntries(
    config.rbq.repositories.map((r) => [r.id, { token: readSecretFile(r.token_file), prefix: r.prefix ?? `repositories/${r.id}/`, writable: r.writable, quotaBytes: r.quota_bytes }]),
  );
  return {
    sql,
    objects,
    kv,
    mailer: createMailer(config),
    config: {
      publicUrl: config.public_url,
      mailFrom: config.mail.from ? { email: config.mail.from, name: config.mail.from_name } : undefined,
      rbqRepositories,
      adminToken: config.admin.token_file ? readSecretFile(config.admin.token_file) : undefined,
      rateLimitPerMinute: config.limits.rate_per_minute,
      maxDepth: config.limits.max_depth,
    },
  };
}
