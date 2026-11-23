import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

/** Lowercase hex SHA-256: the digest form used on the wire and on disk. */
export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

export function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Incremental SHA-256 for files larger than one chunk. */
export function createSha256() {
  const hash = sha256.create();
  return {
    update(data: Uint8Array) {
      hash.update(data);
      return this;
    },
    hex(): string {
      return bytesToHex(hash.digest());
    },
  };
}
