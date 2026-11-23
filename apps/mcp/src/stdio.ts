import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ObjectStore, SqlStore } from "@opendata/ports";
import { createMcpServer } from "./server";

/** stdio transport for local clients (Claude Desktop, Claude Code). Logs go to stderr only. */
export async function serveStdio(sql: SqlStore, objects?: ObjectStore): Promise<void> {
  const server = createMcpServer(sql, objects);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.on("close", resolve));
}
