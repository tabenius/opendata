/**
 * Streamable HTTP, stateless (a fresh server and transport per request, JSON
 * responses), so it runs unchanged on Workers and Node. Optional bearer token.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ObjectStore, SqlStore } from "@opendata/ports";
import { createMcpServer } from "./server";

export interface McpHttpOptions {
  sql: SqlStore;
  objects?: ObjectStore;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
}

function sameToken(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function handleMcp(request: Request, options: McpHttpOptions): Promise<Response> {
  if (options.token && !sameToken(request.headers.get("authorization") ?? "", `Bearer ${options.token}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } });
  }
  if (request.method === "GET" || request.method === "DELETE") {
    // Stateless server: no server-initiated streams, no sessions to end.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMcpServer(options.sql, options.objects);
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete when handleRequest resolves.
    void server.close();
  }
}
