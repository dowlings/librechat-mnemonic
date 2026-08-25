# Issue Tracker — Post-Review Findings

Generated during the critical review of PR #8. Issues are prioritised using
the MoSCoW method so they can be triaged into milestones.

## Priority Key

| Priority | Meaning | When to fix |
| --- | --- | --- |
| **P1 — Must** | Correctness or security risk | Before production deploy |
| **P2 — Should** | Performance or reliability concern | Next milestone |
| **P3 — Could** | Nice-to-have improvement | Backlog |
| **P4 — Won't** (for now) | Documented limitation, no action needed | — |

---

## P2 — Should: Unbounded cache growth

**File:** `src/cache.ts`

All three caches (`noteBodyCache`, `recallCache`, `settingsCache`) use
unbounded `Map`s. In a long-running process with many conversations and
users, these can grow without limit.

**Fix:** Add a `maxSize` option to `TtlCache`. When exceeded, evict the
oldest entries (or use an LRU policy). A simple approach: track insertion
order via `Map` iteration order and delete the first entry when full.

**Test:** Verify eviction triggers at `maxSize` and evicts the oldest entry.

---

## P2 — Should: `hashString` collision risk

**File:** `src/memory/service.ts`

The `hashString` function is a 32-bit djb2-like hash. Different queries
could produce the same hash, causing incorrect recall cache hits.

**Fix:** Use the raw query string (truncated to a reasonable length) as
part of the cache key instead of hashing, or use a proper hash like
`node:crypto.createHash('sha256')`.

**Test:** Find two strings that collide and verify they get separate
cache entries (or verify the full-query approach doesn't collide).

---

## P2 — Should: `writeMemories` span leak on catch-block throw

**File:** `src/proxy/handler.ts`

If `writeMemories` throws and the `catch` block itself throws (unlikely
but possible if `logger.error` throws), the `writeSpan` is never ended,
leaking a span in Langfuse.

**Fix:** Move `writeSpan.end()` to a `finally` block:

```typescript
async function writeMemories(args: WriteArgs): Promise<void> {
  const { config, memory, context, userText, assistantText, trace } = args;
  const writeSpan = trace.span({ name: 'memory-write' });
  try {
    // ... existing logic ...
    writeSpan.end({ candidates: candidates.length, cacheStats: memory.cacheStats.noteBody });
  } catch (error) {
    writeSpan.end({ error: 'write-failed' });
    logger.error({ err: error }, 'post-turn memory write failed');
  } finally {
    // Ensure the span is always ended, even if the catch block throws.
    // Calling end() twice is safe — the SDK ignores the second call.
    writeSpan.end();
  }
}
```

**Test:** Mock `logger.error` to throw and verify the span still ends.

---

## P3 — Could: `getOrCompute` race condition

**File:** `src/cache.ts`

Two concurrent `getOrCompute` calls with the same key both compute and
both call `set`. The second overwrites the first. For note bodies this
means two `get` calls to mnemonic instead of one.

**Fix:** Track in-flight computations by key. The second caller awaits
the first's promise instead of computing again:

```typescript
private readonly inflight = new Map<K, Promise<V>>();

async getOrCompute(key: K, compute: () => Promise<V>): Promise<V> {
  const cached = this.get(key);
  if (cached !== undefined) return cached;
  const existing = this.inflight.get(key);
  if (existing) return existing;
  const promise = compute().then((value) => {
    this.set(key, value);
    this.inflight.delete(key);
    return value;
  });
  this.inflight.set(key, promise);
  return promise;
}
```

**Test:** Already documented in `test/cache-edge.test.ts`. Add a test
verifying the fix deduplicates concurrent computes.

---

## P3 — Could: `settingsCache` caches the default setting

**File:** `src/librechat/mongo.ts`

When no conversation or user override exists, `getMemorySetting` caches
`{ enabled: config.default, source: 'default' }`. If an operator changes
`MEMORY_DEFAULT_ENABLED` via env var, the cached default persists until
TTL expiry or restart.

**Impact:** Low — env var changes require restarts anyway. But if a
future feature allows runtime config changes, this cache would block
them.

**Fix:** Don't cache the `default` source, or add a `clearSettingsCache()`
method for runtime config changes.

---

## P4 — Won't (for now): Note body cache serves stale data after external update

**File:** `src/memory/service.ts`

If a note is updated externally (via MCP tools or another mnemonic client),
the proxy serves stale cached content for up to `CACHE_NOTE_BODY_TTL_MS`.

**Status:** Documented in README and tested in
`test/memory-cache.test.ts`. The TTL defaults (5 min) are conservative
enough that this is acceptable. If it becomes a problem, lower the TTL
or add a webhook-based invalidation mechanism.

---

## P4 — Won't (for now): `langfuse` imported unconditionally

**File:** `src/telemetry.ts`

The `import { Langfuse } from 'langfuse'` at the top of the file loads
the SDK even when telemetry is disabled.

**Status:** Langfuse will always be enabled in our deployment, so this
is not a concern. If it becomes one, switch to a dynamic import:

```typescript
export async function createTelemetry(config: TelemetryConfig): Promise<Telemetry> {
  if (config.enabled && config.publicKey && config.secretKey) {
    const { Langfuse } = await import('langfuse');
    return new LangfuseTelemetry(config.publicKey, config.secretKey, config.baseUrl, Langfuse);
  }
  return new NoopTelemetry();
}
```