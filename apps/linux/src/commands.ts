/** Commands and routes added by later milestones (snapshots, MCP, mail, rbq). */
import type { Hono } from "hono";
import type { Repository } from "@opendata/core";
import type { Services } from "@opendata/api";
import type { Config } from "./config";

export function extendLinux(_app: Hono, _services: Services, _config: Config): void {}

export async function runCommand(
  _command: string,
  _sub: string | undefined,
  _flags: Record<string, string | true>,
  _services: Services,
  _config: Config,
  _repo: Repository,
): Promise<boolean> {
  return false;
}
