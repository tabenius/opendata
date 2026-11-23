/**
 * Minimal per-request batching loader (the DataLoader pattern without the
 * dependency): keys requested in the same tick are fetched in one call.
 */
export class Loader<K, V> {
  private pending = new Map<K, { resolve: (v: V | null) => void; reject: (e: unknown) => void }[]>();
  private cache = new Map<K, Promise<V | null>>();
  private scheduled = false;

  constructor(private readonly batch: (keys: K[]) => Promise<Map<K, V>>) {}

  load(key: K): Promise<V | null> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const promise = new Promise<V | null>((resolve, reject) => {
      const waiters = this.pending.get(key) ?? [];
      waiters.push({ resolve, reject });
      this.pending.set(key, waiters);
    });
    this.cache.set(key, promise);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => void this.dispatch());
    }
    return promise;
  }

  private async dispatch() {
    const batch = this.pending;
    this.pending = new Map();
    this.scheduled = false;
    try {
      const found = await this.batch([...batch.keys()]);
      for (const [key, waiters] of batch) for (const w of waiters) w.resolve(found.get(key) ?? null);
    } catch (error) {
      for (const [key, waiters] of batch) {
        this.cache.delete(key);
        for (const w of waiters) w.reject(error);
      }
    }
  }
}
