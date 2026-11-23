import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generated } from "../gen-shared";

describe("files shared with Rust", () => {
  it("are up to date (run `pnpm gen`)", () => {
    const { migrationsJson, vectors } = generated();
    expect(readFileSync(new URL("../../packages/schema/generated/migrations.json", import.meta.url), "utf8")).toBe(migrationsJson);
    expect(readFileSync(new URL("../../contracts/vectors/core.json", import.meta.url), "utf8")).toBe(vectors);
  });
});

describe("PWA security headers", () => {
  it("apps/pwa/public/_headers matches the API policy (run `npx tsx scripts/gen-headers.ts`)", async () => {
    const { headersFile } = await import("../gen-headers");
    expect(readFileSync(new URL("../../apps/pwa/public/_headers", import.meta.url), "utf8")).toBe(headersFile());
  });
});
