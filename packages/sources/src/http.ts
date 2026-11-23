/**
 * Polite HTTP for government APIs: a minimum interval between calls
 * (token-bucket of one), Retry-After on 429/503, bounded retries and an
 * optional hard call budget per run.
 */
export interface PoliteFetchOptions {
  /** Minimum milliseconds between requests (SCB FR: 5/s -> 200; use 250). */
  minIntervalMs: number;
  maxRetries?: number;
  budget?: number;
  fetch?: typeof fetch;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class SourceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }
}

export class PoliteFetcher {
  private last = 0;
  private calls = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: PoliteFetchOptions) {}

  get callCount() {
    return this.calls;
  }

  private sleep(ms: number) {
    return (this.options.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  private async slot(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = this.last + this.options.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const retries = this.options.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (this.options.budget !== undefined && this.calls >= this.options.budget) throw new Error(`call budget of ${this.options.budget} exhausted`);
      await this.slot();
      this.calls++;
      const headers = new Headers(init.headers);
      headers.set("User-Agent", this.options.userAgent ?? "opendata/0.1 (+https://github.com/tabenius/opendata)");
      const response = await (this.options.fetch ?? fetch)(url, { ...init, headers, redirect: "error" });
      if ((response.status === 429 || response.status === 503 || response.status === 502) && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 120) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  async json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(url, init);
    if (!response.ok) {
      await response.body?.cancel();
      // Never echo bodies or URLs with credentials into errors.
      throw new SourceHttpError(response.status, new URL(url).pathname, `HTTP ${response.status} from ${new URL(url).host}`);
    }
    return (await response.json()) as T;
  }
}
