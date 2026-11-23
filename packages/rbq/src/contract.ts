/**
 * The rbq repository wire contract, `ragbaz.rbq-repository.v1`.
 * Source of truth: contracts/rbq/rbq-repository.v1.json, vendored from
 * tabenius/rebsync. Constants are read from the file so they cannot drift.
 */
import contract from "../../../contracts/rbq/rbq-repository.v1.json" with { type: "json" };

export { contract };
export {
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  parseObjectKey,
  validatePrefix,
  isObjectKey,
  type ObjectKey,
} from "@opendata/ports";

export const SCHEMA: string = contract.contract;
export const ENDPOINT_PATH_PREFIX: string = contract.endpoint.path_prefix;
export const CONTENT_SHA256_HEADER: string = contract.headers.content_sha256;
export const MAX_OBJECT_BYTES: number = contract.limits.object_bytes;
export const LIST_LIMIT_MIN: number = contract.limits.list_limit_min;
export const LIST_LIMIT_MAX: number = contract.limits.list_limit_max;
export const LIST_LIMIT_DEFAULT: number = contract.limits.list_limit_default;

const TOKEN = /^rbm_[0-9a-f]{64}$/;
const ENDPOINT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `rbm_` followed by 64 lowercase hex digits. */
export function validToken(token: string): boolean {
  return TOKEN.test(token);
}

/** Lowercase hyphenated UUID. */
export function validEndpointId(id: string): boolean {
  return ENDPOINT_ID.test(id);
}

/** Constant-time string comparison for bearer tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Random rbm_ token (WebCrypto, both runtimes). */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `rbm_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
