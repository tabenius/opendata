import type { Context } from "hono";
import type { IncomingMessage } from "node:http";

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/**
 * Client identity for rate limiting on Linux: the socket's address. Forwarded
 * headers count only when `trustProxy` is set and the peer is loopback, so a
 * client cannot pick its own identity by sending X-Real-IP.
 */
export function linuxClientId(trustProxy: boolean) {
  return (c: Context): string => {
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    const peer = incoming?.socket?.remoteAddress ?? "unknown";
    if (trustProxy && LOOPBACK.test(peer)) {
      const forwarded = c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded && forwarded.length <= 45) return forwarded;
    }
    return peer;
  };
}
