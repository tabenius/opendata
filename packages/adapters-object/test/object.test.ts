import { mkdtemp, rm } from "node:fs/promises";
import { afterAll } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { objectStoreConformance } from "@opendata/conformance";
import { MemoryObjectStore } from "../src/memory";
import { FsObjectStore } from "../src/fs";

objectStoreConformance("memory", async () => new MemoryObjectStore());
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
objectStoreConformance("fs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "od-fs-"));
  dirs.push(dir);
  return FsObjectStore.open(path.join(dir, "store"));
});
