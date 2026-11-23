import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isObjectKey, validatePrefix } from "@opendata/ports";
import {
  CONTENT_SHA256_HEADER,
  ENDPOINT_PATH_PREFIX,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  MAX_KEY_BYTES,
  MAX_OBJECT_BYTES,
  MAX_SEGMENT_BYTES,
  SCHEMA,
  contract,
  sha256Hex,
  validEndpointId,
  validToken,
} from "../src";

const dir = fileURLToPath(new URL("../../../contracts/rbq/", import.meta.url));

describe("vendored rbq-repository.v1 contract", () => {
  it("matches its pinned checksum", () => {
    const sums = readFileSync(`${dir}SHA256SUMS`, "utf8").trim().split(/\s+/);
    const actual = createHash("sha256").update(readFileSync(`${dir}rbq-repository.v1.json`)).digest("hex");
    expect(actual).toBe(sums[0]);
  });

  it("agrees with the port constants (rebsync tests/rbq_contract.rs)", () => {
    expect(SCHEMA).toBe("ragbaz.rbq-repository.v1");
    expect(ENDPOINT_PATH_PREFIX).toBe("/api/rbq/");
    expect(CONTENT_SHA256_HEADER).toBe("x-content-sha256");
    expect(MAX_OBJECT_BYTES).toBe(262144);
    expect(LIST_LIMIT_MAX).toBe(100);
    expect(LIST_LIMIT_DEFAULT).toBe(20);
    expect(contract.limits.key_bytes).toBe(MAX_KEY_BYTES);
    expect(contract.limits.segment_bytes).toBe(MAX_SEGMENT_BYTES);
  });

  it("accepts and rejects every key vector", () => {
    for (const key of contract.vectors.keys.valid) expect(isObjectKey(key), key).toBe(true);
    for (const key of contract.vectors.keys.invalid) expect(isObjectKey(key), key).toBe(false);
  });

  it("accepts and rejects every prefix vector", () => {
    for (const prefix of contract.vectors.prefixes.valid) expect(() => validatePrefix(prefix), prefix).not.toThrow();
    for (const prefix of contract.vectors.prefixes.invalid) expect(() => validatePrefix(prefix), prefix).toThrow();
  });

  it("accepts and rejects every token and endpoint vector", () => {
    for (const t of contract.vectors.tokens.valid) expect(validToken(t)).toBe(true);
    for (const t of contract.vectors.tokens.invalid) expect(validToken(t)).toBe(false);
    for (const id of contract.vectors.endpoint_ids.valid) expect(validEndpointId(id)).toBe(true);
    for (const id of contract.vectors.endpoint_ids.invalid) expect(validEndpointId(id)).toBe(false);
  });

  it("uses lowercase hex SHA-256", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("enforces the segment and key byte limits", () => {
    expect(isObjectKey("a".repeat(255))).toBe(true);
    expect(isObjectKey("a".repeat(256))).toBe(false);
    expect(isObjectKey(Array.from({ length: 5 }, () => "b".repeat(200)).join("/"))).toBe(true);
    expect(isObjectKey(Array.from({ length: 6 }, () => "b".repeat(200)).join("/"))).toBe(false);
  });
});
