/**
 * A minimal TTL cache.
 *
 * Used for note bodies, recall results, and memory settings. Each cache
 * instance tracks hits and misses so the proxy can report effectiveness in
 * logs and Langfuse span metadata.
 */
export class TtlCache<K, V> {
  private readonly store = new Map<K, { value: V; expiresAt: number }>();
  private hitCount = 0;
  private missCount = 0;

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Return the cached value or compute and cache it. */
  async getOrCompute(key: K, compute: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value);
    return value;
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get stats(): CacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.store.size,
      hitRate: this.hitCount + this.missCount > 0
        ? this.hitCount / (this.hitCount + this.missCount)
        : 0,
    };
  }

  /** Reset counters after reading stats, so each reporting window is clean. */
  resetStats(): void {
    this.hitCount = 0;
    this.missCount = 0;
  }
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  hitRate: number;
}