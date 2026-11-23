/**
 * Approximate per-client limiter, held in memory per process/isolate. It is a
 * first line against scraping, not a guarantee: on Workers each isolate counts
 * separately. Put Cloudflare's rate limiting rules in front for hard limits.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly maxClients = 10000,
  ) {}

  allow(client: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    const minute = Math.floor(now / 60000) * 60000;
    let w = this.windows.get(client);
    if (!w || w.start !== minute) {
      if (this.windows.size >= this.maxClients) this.windows.clear();
      w = { start: minute, count: 0 };
      this.windows.set(client, w);
    }
    w.count++;
    return { ok: w.count <= this.perMinute, retryAfter: Math.ceil((minute + 60000 - now) / 1000) };
  }
}
