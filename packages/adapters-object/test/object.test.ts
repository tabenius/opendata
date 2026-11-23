import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { objectStoreConformance } from "@opendata/conformance";
import { MemoryObjectStore } from "../src/memory";
import { FsObjectStore } from "../src/fs";

objectStoreConformance("memory", async () => new MemoryObjectStore());
objectStoreConformance("fs", async () => FsObjectStore.open(path.join(await mkdtemp(path.join(tmpdir(), "od-fs-")), "store")));
