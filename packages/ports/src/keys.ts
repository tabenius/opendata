/**
 * The rbq object key grammar (rebsync `storage.rs` / `ObjectKey::parse`).
 *
 * ASCII letters, digits, `.`, `-`, `_` in `/`-separated segments. No empty,
 * `.` or `..` segments, no leading or trailing `/`. Deliberately narrower than
 * S3 so filesystem mapping is predictable. `packages/rbq` tests these rules
 * against the vectors in the vendored rbq-repository.v1 contract.
 */
import { StorageError } from "./errors";

export const MAX_KEY_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;

declare const objectKeyBrand: unique symbol;
export type ObjectKey = string & { readonly [objectKeyBrand]: true };

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function validateSegment(segment: string): void {
  if (segment.length === 0) throw StorageError.invalidKey("empty path segment");
  if (segment === "." || segment === "..")
    throw StorageError.invalidKey("path traversal segment is not allowed");
  if (segment.length > MAX_SEGMENT_BYTES)
    throw StorageError.invalidKey(`path segment exceeds ${MAX_SEGMENT_BYTES} bytes`);
  if (!SEGMENT.test(segment))
    throw StorageError.invalidKey(`unsupported character in segment ${JSON.stringify(segment)}`);
}

/** Parse and brand a key; throws `StorageError` kind `InvalidKey`. */
export function parseObjectKey(value: string): ObjectKey {
  if (value.length === 0) throw StorageError.invalidKey("key is empty");
  // ASCII-only grammar, so string length equals byte length once validated.
  if (value.length > MAX_KEY_BYTES) throw StorageError.invalidKey(`key exceeds ${MAX_KEY_BYTES} bytes`);
  if (value.startsWith("/") || value.endsWith("/"))
    throw StorageError.invalidKey("key must not start or end with '/'");
  for (const segment of value.split("/")) validateSegment(segment);
  return value as ObjectKey;
}

export function isObjectKey(value: string): value is ObjectKey {
  try {
    parseObjectKey(value);
    return true;
  } catch {
    return false;
  }
}

/** A raw-prefix query: may end mid-segment, at most one trailing `/`. */
export function validatePrefix(prefix: string): void {
  if (prefix.length === 0) return;
  if (prefix.length > MAX_KEY_BYTES) throw StorageError.invalidKey(`prefix exceeds ${MAX_KEY_BYTES} bytes`);
  if (prefix.startsWith("/")) throw StorageError.invalidKey("prefix must not start with '/'");
  const body = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  for (const segment of body.split("/")) validateSegment(segment);
}

/** Join validated segments into a key. */
export function joinKey(...segments: string[]): ObjectKey {
  return parseObjectKey(segments.join("/"));
}
