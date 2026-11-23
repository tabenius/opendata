#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so the workspace needs no build step.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const result = spawnSync(tsx, ["--no-warnings", cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
