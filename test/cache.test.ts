import { describe, expect, it, vi } from 'vitest';

import { TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('returns undefined for a missing key and counts a miss', () => {
    const cache = new TtlCache<string, number>(1000);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.hitRate).toBe(0);
  });

  it('returns a cached value and counts a hit', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('key', 42);
    expect(cache.get('key')).toBe(42);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(0);
    expect(cache.stats.hitRate).toBe(1);
  });

  it('expires entries after the TTL', () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, number>(100);
    cache.set('key', 42);
    vi.advanceTimersByTime(50);
    expect(cache.get('key')).toBe(42);
    vi.advanceTimersByTime(60);
    expect(cache.get('key')).toBeUndefined();
    vi.useRealTimers();
  });

  it('getOrCompute caches the computed value', async () => {
    const cache = new TtlCache<string, number>(1000);
    const compute = vi.fn(async () => 99);
    expect(await cache.getOrCompute('key', compute)).toBe(99);
    expect(await cache.getOrCompute('key', compute)).toBe(99);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('delete removes an entry', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('key', 42);
    cache.delete('key');
    expect(cache.get('key')).toBeUndefined();
  });

  it('clear removes all entries', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('resetStats zeroes the counters', () => {
    const cache = new TtlCache<string, number>(1000);
    cache.set('key', 42);
    cache.get('key');
    cache.get('missing');
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
    cache.resetStats();
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(0);
    // Size is unaffected by resetStats.
    expect(cache.stats.size).toBe(1);
  });

  it('reports size accurately', () => {
    const cache = new TtlCache<string, number>(1000);
    expect(cache.stats.size).toBe(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.stats.size).toBe(2);
  });

  // ── maxSize eviction ────────────────────────────────────────────────────────

  it('evicts the oldest entry once maxSize is exceeded', () => {
    const cache = new TtlCache<string, number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.stats.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('re-setting an existing key does not evict when at maxSize', () => {
    const cache = new TtlCache<string, number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    expect(cache.stats.size).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBe(2);
  });

  it('has unbounded size when maxSize is not provided', () => {
    const cache = new TtlCache<string, number>(1000);
    for (let i = 0; i < 50; i++) cache.set(`key-${i}`, i);
    expect(cache.stats.size).toBe(50);
  });
});
