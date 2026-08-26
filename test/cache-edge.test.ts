import { describe, expect, it, vi } from 'vitest';

import { TtlCache } from '../src/cache.js';

describe('TtlCache — edge cases', () => {
  it('expires at exactly the TTL boundary', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(1000);
    cache.set('key', 42);
    vi.advanceTimersByTime(999);
    expect(cache.get('key')).toBe(42); // still valid at 999ms
    vi.advanceTimersByTime(1);
    expect(cache.get('key')).toBeUndefined(); // expired at 1000ms
    vi.useRealTimers();
  });

  it('does not resurrect an expired entry via getOrCompute', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(100);
    cache.set('key', 42);
    vi.advanceTimersByTime(150);
    // Expired — getOrCompute should recompute
    const compute = vi.fn(async () => 99);
    const result = await cache.getOrCompute('key', compute);
    expect(result).toBe(99);
    expect(compute).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('getOrCompute with concurrent calls: both compute (race condition documented)', async () => {
    const cache = new TtlCache<string, number>(10_000);
    let callCount = 0;
    const compute = vi.fn(async () => {
      callCount++;
      // Simulate async work so both calls start before either settles
      await new Promise((r) => setTimeout(r, 10));
      return callCount;
    });

    // Fire two concurrent getOrCompute calls
    const [a, b] = await Promise.all([
      cache.getOrCompute('key', compute),
      cache.getOrCompute('key', compute),
    ]);

    // Both compute ran — this is the known race. The last writer wins.
    expect(compute).toHaveBeenCalledTimes(2);
    // One of them will be the cached value (the last to settle)
    expect([a, b]).toContain(2);
  });

  it('updating a value resets the TTL', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(1000);
    cache.set('key', 1);
    vi.advanceTimersByTime(500);
    cache.set('key', 2); // should reset TTL
    vi.advanceTimersByTime(600); // 1100ms since first set, 600ms since second
    expect(cache.get('key')).toBe(2); // still valid because TTL was reset
    vi.useRealTimers();
  });

  it('handles objects as values (reference identity)', () => {
    const cache = new TtlCache<string, { count: number }>(1000);
    const obj = { count: 1 };
    cache.set('key', obj);
    expect(cache.get('key')).toBe(obj); // same reference
  });

  it('delete on a missing key is a no-op', () => {
    const cache = new TtlCache<string, number>(1000);
    expect(() => cache.delete('nonexistent')).not.toThrow();
  });

  it('clear on an empty cache is a no-op', () => {
    const cache = new TtlCache<string, number>(1000);
    expect(() => cache.clear()).not.toThrow();
    expect(cache.stats.size).toBe(0);
  });

  it('stats hitRate is 0 when no operations have occurred', () => {
    const cache = new TtlCache<string, number>(1000);
    expect(cache.stats.hitRate).toBe(0);
  });

  it('overwriting a key does not inflate size', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('key', 1);
    cache.set('key', 2);
    expect(cache.stats.size).toBe(1);
  });
});