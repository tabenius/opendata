/**
 * Configuration, rbq-style. Precedence (lowest first): built-in defaults,
 * $XDG_CONFIG_HOME/opendata/config.toml, --config PATH, CLI overrides.
 * Unknown keys are errors. Secrets are never in the file: `*_file` keys name
 * owner-only files (mode 0600/0400), refused if group/world readable.
 * Relative paths resolve against the directory of the file that set them.
 */
import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { fileURLToPath } from "node:url";

export interface Config {
  public_url: string;
  /** Built PWA to serve at /, if present. */
  pwa_dir: string;
  /** Trust X-Real-IP / X-Forwarded-For, but only from a loopback peer (a local reverse proxy). */
  trust_proxy: boolean;
  listen: string;
  data_dir: string;
  objects: { type: "fs" | "s3"; root: string; endpoint?: string; bucket?: string; region?: string; prefix?: string; access_key_id_file?: string; secret_access_key_file?: string };
  sql: { type: "sqlite"; file: string };
  kv: { type: "sqlite" | "redis" | "memory"; url_file?: string; url?: string; namespace?: string };
  mail: { type: "none" | "smtp" | "resend" | "log"; from?: string; from_name?: string; host?: string; port?: number; secure?: boolean; user?: string; password_file?: string; api_key_file?: string };
  scb: { api_key_file?: string };
  bolagsverket: { environment: "prod" | "test"; client_id?: string; client_secret_file?: string };
  px: { tables: { id: string; region_variable?: string; filters?: Record<string, string> }[] };
  rbq: { repositories: { id: string; token_file: string; prefix?: string; writable?: boolean; quota_bytes?: number }[] };
  admin: { token_file?: string };
  mcp: { token_file?: string };
  limits: { rate_per_minute: number; max_depth: number };
  snapshot: { label: string; chunk_bytes: number };
}

export const DEFAULTS: Config = {
  public_url: "http://127.0.0.1:8787",
  pwa_dir: fileURLToPath(new URL("../../pwa/dist", import.meta.url)),
  trust_proxy: false,
  listen: "127.0.0.1:8787",
  data_dir: path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"), "opendata"),
  objects: { type: "fs", root: "objects" },
  sql: { type: "sqlite", file: "opendata.sqlite" },
  kv: { type: "sqlite" },
  mail: { type: "none" },
  scb: {},
  bolagsverket: { environment: "prod" },
  px: { tables: [] },
  rbq: { repositories: [] },
  admin: {},
  mcp: {},
  limits: { rate_per_minute: 120, max_depth: 8 },
  snapshot: { label: "local", chunk_bytes: 65536 },
};

const PATH_KEYS = new Set(["pwa_dir", "data_dir", "root", "file", "url_file", "password_file", "api_key_file", "client_secret_file", "access_key_id_file", "secret_access_key_file", "token_file"]);

type Json = Record<string, unknown>;

function merge(base: Json, layer: Json, where: string, baseDir: string): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (!(key in base)) {
      // Optional keys are declared by the defaults' shape; a few sections take arbitrary optional keys.
      const optional = ["objects", "kv", "mail", "scb", "bolagsverket", "admin", "mcp"].some((s) => where.endsWith(`.${s}`) || where === s);
      if (!optional) throw new Error(`unknown configuration key ${where ? `${where}.` : ""}${key}`);
    }
    const current = base[key];
    if (value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)) {
      out[key] = merge(current as Json, value as Json, where ? `${where}.${key}` : key, baseDir);
    } else if (PATH_KEYS.has(key) && typeof value === "string") {
      out[key] = path.resolve(baseDir, value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object"
          ? Object.fromEntries(Object.entries(item as Json).map(([k, v]) => [k, PATH_KEYS.has(k) && typeof v === "string" ? path.resolve(baseDir, v) : v]))
          : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

const KNOWN: Record<string, string[]> = {
  objects: ["type", "root", "endpoint", "bucket", "region", "prefix", "access_key_id_file", "secret_access_key_file"],
  kv: ["type", "url_file", "url", "namespace"],
  mail: ["type", "from", "from_name", "host", "port", "secure", "user", "password_file", "api_key_file"],
  scb: ["api_key_file"],
  bolagsverket: ["environment", "client_id", "client_secret_file"],
  admin: ["token_file"],
  mcp: ["token_file"],
};

function checkSections(config: Json) {
  for (const [section, keys] of Object.entries(KNOWN)) {
    for (const key of Object.keys((config[section] as Json) ?? {})) if (!keys.includes(key)) throw new Error(`unknown configuration key ${section}.${key}`);
  }
}

export interface LoadOptions {
  configPath?: string;
  overrides?: Partial<Record<"listen" | "public_url" | "data_dir", string>>;
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadOptions = {}): { config: Config; files: string[] } {
  const env = options.env ?? process.env;
  let config = structuredClone(DEFAULTS) as unknown as Json;
  const files: string[] = [];
  const xdg = path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opendata", "config.toml");
  for (const file of [existsSync(xdg) ? xdg : undefined, options.configPath]) {
    if (!file) continue;
    const parsed = parse(readFileSync(file, "utf8")) as Json;
    config = merge(config, parsed, "", path.dirname(path.resolve(file)));
    files.push(path.resolve(file));
  }
  for (const [k, v] of Object.entries(options.overrides ?? {})) if (v !== undefined) config[k] = k === "data_dir" ? path.resolve(v) : v;
  checkSections(config);
  const c = config as unknown as Config;
  // Data-relative paths (objects.root, sql.file) resolve against data_dir when still relative defaults.
  if (!path.isAbsolute(c.objects.root)) c.objects.root = path.join(c.data_dir, c.objects.root);
  if (!path.isAbsolute(c.sql.file)) c.sql.file = path.join(c.data_dir, c.sql.file);
  return { config: c, files };
}

/** Read an owner-only secret file (rbq `read_secret_file`): <= 4 KiB UTF-8, newline trimmed. */
export function readSecretFile(file: string): string {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${file} must not be group- or world-readable (chmod 600)`);
  if (stat.size > 4096) throw new Error(`${file} exceeds 4 KiB`);
  return readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
}

/** Config with secret-bearing values redacted, for `config explain`. */
export function explain(config: Config): Config {
  const copy = structuredClone(config);
  if (copy.kv.url) copy.kv.url = copy.kv.url.replace(/\/\/[^@/]*@/, "//<redacted>@");
  return copy;
}
