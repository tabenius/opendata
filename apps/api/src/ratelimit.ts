/**
 * Approximate per-client limiter, held in memory per process/isolate. It is a
 * first line against scraping, not a guarantee: on Workers each isolate counts
 * separately. Put Cloudflare's rate limiting rules in front for hard limits.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly perWindow: number,
    private readonly maxClients = 10000,
    private readonly windowMs = 60000,
  ) {}

  allow(client: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    let w = this.windows.get(client);
    if (!w || w.start !== start) {
      if (this.windows.size >= this.maxClients) this.windows.clear();
      w = { start, count: 0 };
      this.windows.set(client, w);
    }
    w.count++;
    return { ok: w.count <= this.perWindow, retryAfter: Math.ceil((start + this.windowMs - now) / 1000) };
  }
}
