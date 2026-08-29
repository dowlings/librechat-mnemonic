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

## Fixed — Critical: PR did not typecheck / build

**Files:** `src/librechat/mongo.ts`, `src/telemetry.ts`, `package-lock.json`,
several test files

While adding the settings cache, the `private async settings(): Promise<Collection>`
helper was accidentally deleted from `LibreChatStore`, even though every
settings method (`getMemorySetting`, `setConversationMemory`,
`clearConversationMemory`, `setUserDefaultMemory`) still called
`this.settings()`. This was a compile error (`tsc --noEmit` failed) and
would have thrown at runtime for every settings read/write.

Also fixed in the same pass, all pre-existing on this branch before any
review feedback landed:

- `src/telemetry.ts`: `Trace.end()` called `trace.end()`, but the Langfuse
  SDK's `LangfuseTraceClient` has no `end` method (only spans/generations
  do). Traces close implicitly once their observations stop arriving, so
  the fix makes `Trace.end()` a no-op for the real implementation.
- `package-lock.json` was missing the `langfuse` entry entirely even
  though `package.json` declared it — `npm ci` would have failed.
- `test/telemetry.test.ts` used `beforeEach` without importing it.
- `test/memory-cache.test.ts` had a mock (`getNotesOverride`) that wasn't
  exposed on the returned mock object, a `mockImplementationOnce` override
  that silently dropped call recording, a dedupe-check false positive that
  masked cache-invalidation being untested, and a context helper typed
  too narrowly to accept `null` overrides.
- `test/memory-service.test.ts` had a test with dead code and an assertion
  that expected a cache *miss* to still hit mnemonic once — inverted from
  the caching behaviour it was meant to verify.
- `src/cache.ts`: `TtlCache.get` used strict `>` for TTL expiry, so an
  entry was still considered valid at the exact millisecond it expired.
  `test/cache-edge.test.ts` already asserted the boundary should be
  expired; fixed to `>=`.

**Status:** All fixed. `npm run typecheck` and `npm test` (142/142) are
green on this branch.

---

## Fixed — P2 — Should: Unbounded cache growth

**File:** `src/cache.ts`

All three caches (`noteBodyCache`, `recallCache`, `settingsCache`) used
unbounded `Map`s. In a long-running process with many conversations and
users, these could grow without limit.

**Fix:** Added a `maxSize` constructor option to `TtlCache` (FIFO eviction
via `Map` insertion order — the oldest entry is dropped once a fresh key
would exceed the cap). Wired through a new `CACHE_MAX_ENTRIES` env var
(default `5000`) applied to all three caches.

**Test:** `test/cache.test.ts` covers eviction at `maxSize`, that
re-setting an existing key doesn't evict, and that omitting `maxSize`
stays unbounded.

---

## Fixed — P2 — Should: `hashString` collision risk

**File:** `src/memory/service.ts`

The `hashString` function was a 32-bit djb2-like hash. Different queries
could produce the same hash, causing incorrect recall cache hits.

**Fix:** Replaced with `node:crypto.createHash('sha256')`.

---

## Fixed — P2 — Should: `writeMemories` span leak on catch-block throw

**File:** `src/proxy/handler.ts`

If `writeMemories` threw and the `catch` block itself threw (unlikely but
possible if `logger.error` throws), the `writeSpan` was never ended,
leaking a span in Langfuse.

**Fix:** The span end is now in a `finally` block, called exactly once
regardless of which path is taken.

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

## P4 — Won't (for now): `@langfuse/*` imported unconditionally

**File:** `src/telemetry.ts`

The `@langfuse/tracing` / `@langfuse/otel` imports at the top of the file
load the SDK even when telemetry is disabled. Nothing is *constructed* in
that case — `NoopTelemetry` never touches OTel — but the modules are
still parsed.

**Status:** Langfuse will always be enabled in our deployment, so this
is not a concern. If it becomes one, switch to a dynamic import:

```typescript
export async function createTelemetry(config: TelemetryConfig): Promise<Telemetry> {
  if (config.enabled && config.publicKey && config.secretKey) {
    const { LangfuseSpanProcessor } = await import('@langfuse/otel');
    return new LangfuseTelemetry(new LangfuseSpanProcessor({ ...config }));
  }
  return new NoopTelemetry();
}
```