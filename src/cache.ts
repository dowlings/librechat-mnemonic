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

  /**
   * `maxSize` bounds unbounded growth in a long-running process with many
   * conversations/users. `Map` preserves insertion order, so the oldest entry
   * is simply the first one iterated — a cheap FIFO eviction, not true LRU.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly maxSize = Infinity,
  ) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.missCount++;
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    return entry.value;
  }

  set(key: K, value: V): void {
    // Evict the oldest entry first so a fresh key doesn't push size past the
    // limit; re-setting an existing key doesn't need an eviction.
    if (!this.store.has(key) && this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
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

  /** Delete all keys whose string representation starts with `prefix`. Returns count deleted. */
  deleteByPrefix(prefix: string): number {
    let deleted = 0;
    for (const key of this.store.keys()) {
      if (String(key).startsWith(prefix)) {
        this.store.delete(key);
        deleted++;
      }
    }
    return deleted;
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