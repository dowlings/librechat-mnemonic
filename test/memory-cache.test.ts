import { describe, expect, it, vi } from 'vitest';

import { MemoryService } from '../src/memory/service.js';
import type { AppConfig } from '../src/config.js';
import type { MnemonicResult } from '../src/mnemonic/client.js';
import type { GetResponse, RecallResponse, RememberResponse } from '../src/memory/types.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

const baseConfig: AppConfig = {
  port: 8710,
  host: '0.0.0.0',
  logLevel: 'silent',
  librechat: {
    mongoUri: 'mongodb://localhost',
    userHeader: 'x-librechat-user-id',
    conversationHeader: 'x-librechat-conversation-id',
  },
  upstreams: [],
  mnemonic: {
    mode: 'spawn',
    command: 'node',
    args: [],
    headers: {},
    vaultPath: '/vault',
    projectRoot: '/projects',
    createProjectDirs: true,
    writeScope: 'global',
    recallScope: 'all',
    recallLimit: 6,
    minSimilarity: 0.3,
    timeoutMs: 20000,
    tag: 'librechat',
  },
  memory: {
    defaultEnabled: true,
    recallEnabled: true,
    writeMode: 'llm',
    maxContextChars: 4000,
    queryMessageCount: 3,
    queryMaxChars: 1500,
    maxPerTurn: 3,
    dedupeThreshold: 0.82,
    commandPrefix: '/memory',
    projectless: 'global',
  },
  prompt: { datetimeEnabled: true },
  extract: {
    timeoutMs: 30000,
  },
  mcp: {
    enabled: true,
    path: '/mcp',
  },
  cache: {
    noteBodyTtlMs: 300_000,
    recallTtlMs: 120_000,
    settingsTtlMs: 30_000,
    maxEntries: 5_000,
  },
  telemetry: {
    enabled: false,
    baseUrl: 'https://cloud.langfuse.com',
    environment: 'test',
  },
};

function makeContext(
  overrides: Partial<{
    userId: string | null;
    conversationId: string | null;
    projectName: string | null;
    cwd: string | null;
  }> = {},
) {
  return {
    userId: 'user-1',
    conversationId: 'conv-1',
    projectName: 'test-project',
    cwd: '/projects/test-project/abc123',
    ...overrides,
  };
}

function createMockMnemonic(
  opts: {
    recallResults?: Array<{
      id: string;
      title: string;
      score: number;
      boosted?: number;
      tags?: string[];
      vault?: string;
      project?: { id: string; name: string };
    }>;
    rememberResult?: RememberResponse;
    forgetShouldFail?: boolean;
    getNotesOverride?: Map<string, { id: string; title: string; content: string; tags?: string[] }>;
  } = {},
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const mock = {
    call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });

      if (tool === 'recall') {
        return {
          structured: { action: 'recall', results: opts.recallResults ?? [] } as RecallResponse,
          text: '',
        } satisfies MnemonicResult<RecallResponse>;
      }

      if (tool === 'forget') {
        if (opts.forgetShouldFail) throw new Error('mock forget failure');
        return { structured: undefined, text: '' } satisfies MnemonicResult<unknown>;
      }

      if (tool === 'remember') {
        return {
          structured: opts.rememberResult ?? { action: 'remember', id: 'new-note-id' },
          text: '',
        } satisfies MnemonicResult<RememberResponse>;
      }

      if (tool === 'get') {
        const ids = args.ids as string[];
        const notes = ids.map((id) => {
          const override = opts.getNotesOverride?.get(id);
          return (
            override ?? {
              id,
              title: `Note ${id}`,
              content: `Content for ${id}`,
              tags: [],
              lifecycle: 'permanent',
            }
          );
        });
        return { structured: { action: 'get', notes } as GetResponse, text: '' };
      }

      return { structured: undefined, text: '' };
    }),
    calls,
    getNotesOverride: opts.getNotesOverride,
  };

  return mock;
}

function createMockStore() {
  return {
    getConversationProject: vi.fn().mockResolvedValue({
      chatProjectId: 'abc123',
      name: 'test-project',
    }),
    getMemorySetting: vi.fn().mockResolvedValue({ enabled: true, source: 'default' }),
    setConversationMemory: vi.fn().mockResolvedValue(undefined),
    clearConversationMemory: vi.fn().mockResolvedValue(undefined),
    setUserDefaultMemory: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Recall cache isolation tests ────────────────────────────────────────────

describe('MemoryService.recall — cache isolation', () => {
  it('different conversations get different cache entries', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctxA = makeContext({ conversationId: 'conv-a' });
    const ctxB = makeContext({ conversationId: 'conv-b' });

    await service.recall(ctxA, 'same query');
    await service.recall(ctxB, 'same query');

    // Two recall calls because different conversations = different cache keys
    const recallCalls = mnemonic.calls.filter((c) => c.tool === 'recall');
    expect(recallCalls).toHaveLength(2);
  });

  it('different scopes produce different cache entries', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();
    await service.recall(ctx, 'query', { scope: 'all' });
    await service.recall(ctx, 'query', { scope: 'project' });

    const recallCalls = mnemonic.calls.filter((c) => c.tool === 'recall');
    expect(recallCalls).toHaveLength(2);
  });

  it('different limits produce different cache entries', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();
    await service.recall(ctx, 'query', { limit: 5 });
    await service.recall(ctx, 'query', { limit: 10 });

    const recallCalls = mnemonic.calls.filter((c) => c.tool === 'recall');
    expect(recallCalls).toHaveLength(2);
  });
});

// ── Recall cache invalidation tests ─────────────────────────────────────────

describe('MemoryService — cache invalidation on writes', () => {
  it('save invalidates the recall cache for every conversation, not just the writer', async () => {
    // Memories live in one global vault (see MemoryService class docs): a note
    // written from conv-A can surface in conv-B's recall results whenever they
    // share a project or recall scope is "all"/"global". Conversation-scoped
    // invalidation would leave conv-B's cache stale, so a write in conv-A must
    // invalidate conv-B's cached recall too.
    const mnemonic = createMockMnemonic({
      // Below the default dedupe threshold (0.82) so the save's own duplicate
      // check doesn't block the write and short-circuit cache invalidation.
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.5, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctxA = makeContext({ conversationId: 'conv-a' });
    const ctxB = makeContext({ conversationId: 'conv-b' });

    // Prime both caches
    await service.recall(ctxA, 'query');
    await service.recall(ctxB, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall')).toHaveLength(2);

    // Save in conv-A
    await service.save(ctxA, { title: 'New', content: 'content', role: 'context' });

    // Conv-A recall should miss (invalidated)
    mnemonic.calls.length = 0;
    await service.recall(ctxA, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall')).toHaveLength(1);

    // Conv-B recall should also miss — the write is visible vault-wide, so
    // conv-B's stale cache entry must be invalidated too.
    mnemonic.calls.length = 0;
    await service.recall(ctxB, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall')).toHaveLength(1);
  });

  it('save invalidates recall cache so next recall hits mnemonic', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime the recall cache
    await service.recall(ctx, 'query');
    const recallCountAfterPrime = mnemonic.calls.filter((c) => c.tool === 'recall').length;
    expect(recallCountAfterPrime).toBe(1);

    // Save a new memory — should invalidate the recall cache
    await service.save(ctx, {
      title: 'New note',
      content: 'New content',
      role: 'context',
    });

    // Next recall with the same query should hit mnemonic again
    await service.recall(ctx, 'query');
    const recallCountAfterSave = mnemonic.calls.filter((c) => c.tool === 'recall').length;
    expect(recallCountAfterSave).toBeGreaterThan(1);
  });

  it('forget invalidates recall cache', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime the recall cache
    await service.recall(ctx, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall').length).toBe(1);

    // Forget a note — should invalidate the recall cache
    await service.forget(ctx, 'note-1');

    // Next recall should hit mnemonic again
    await service.recall(ctx, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall').length).toBe(2);
  });

  it('update invalidates recall cache', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime the recall cache
    await service.recall(ctx, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall').length).toBe(1);

    // Update a note — should invalidate the recall cache
    await service.update(ctx, 'note-1', { content: 'updated content' });

    // Next recall should hit mnemonic again
    await service.recall(ctx, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall').length).toBe(2);
  });

  it('forget invalidates note body cache for the forgotten note', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime the note body cache
    await service.getNotes(['note-1'], ctx);
    expect(mnemonic.calls.filter((c) => c.tool === 'get').length).toBe(1);

    // Forget the note
    await service.forget(ctx, 'note-1');

    // Next getNotes for the same ID should hit mnemonic again
    await service.getNotes(['note-1'], ctx);
    expect(mnemonic.calls.filter((c) => c.tool === 'get').length).toBe(2);
  });

  it('update invalidates note body cache for the updated note', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime the note body cache
    await service.getNotes(['note-1'], ctx);
    expect(mnemonic.calls.filter((c) => c.tool === 'get').length).toBe(1);

    // Update the note
    await service.update(ctx, 'note-1', { content: 'new content' });

    // Next getNotes should hit mnemonic again
    await service.getNotes(['note-1'], ctx);
    expect(mnemonic.calls.filter((c) => c.tool === 'get').length).toBe(2);
  });
});

// ── Note body cache edge cases ──────────────────────────────────────────────

describe('MemoryService.getNotes — cache edge cases', () => {
  it('partial cache hit: fetches only missing notes', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [],
      getNotesOverride: new Map([
        ['note-2', { id: 'note-2', title: 'Note 2', content: 'Content 2' }],
      ]),
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime cache with note-1
    await service.getNotes(['note-1'], ctx);
    mnemonic.calls.length = 0;

    // Request both note-1 (cached) and note-2 (not cached)
    const result = await service.getNotes(['note-1', 'note-2'], ctx);

    // Should have fetched only note-2 via get
    const getCalls = mnemonic.calls.filter((c) => c.tool === 'get');
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.args.ids).toEqual(['note-2']);
    // Both notes should be in the result
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain('note-1');
    expect(ids).toContain('note-2');
  });

  it('serves stale data after external update (documented limitation)', async () => {
    // This test documents the behaviour: if a note is updated externally
    // (not via MemoryService.update), the cache serves stale content until TTL.
    let noteContent = 'original content';
    const mnemonic = createMockMnemonic({
      recallResults: [],
      getNotesOverride: new Map([
        ['note-1', { id: 'note-1', title: 'Note 1', content: noteContent }],
      ]),
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Prime cache
    const first = await service.getNotes(['note-1'], ctx);
    expect(first[0]!.content).toBe('original content');

    // Simulate external update: change what mnemonic would return
    noteContent = 'updated externally';
    mnemonic.getNotesOverride?.set('note-1', {
      id: 'note-1',
      title: 'Note 1',
      content: noteContent,
    });

    // Clear call log
    mnemonic.calls.length = 0;

    // Second call should return cached (stale) content, not hit mnemonic
    const second = await service.getNotes(['note-1'], ctx);
    expect(second[0]!.content).toBe('original content'); // stale!
    expect(mnemonic.calls.filter((c) => c.tool === 'get')).toHaveLength(0); // no mnemonic call
  });

  it('returns empty array for empty ids without calling mnemonic', async () => {
    const mnemonic = createMockMnemonic({});
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.getNotes([], makeContext());
    expect(result).toEqual([]);
    expect(mnemonic.calls).toHaveLength(0);
  });
});

// ── Recall edge cases ───────────────────────────────────────────────────────

describe('MemoryService.recall — edge cases', () => {
  it('empty query returns [] without calling mnemonic or caching', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.recall(makeContext(), '');
    expect(result).toEqual([]);
    expect(mnemonic.calls).toHaveLength(0);
  });

  it('whitespace-only query returns [] without calling mnemonic', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.recall(makeContext(), '   ');
    expect(result).toEqual([]);
    expect(mnemonic.calls).toHaveLength(0);
  });

  it('recall with no results does not cache empty arrays', async () => {
    const mnemonic = createMockMnemonic({ recallResults: [] });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // First recall returns empty
    const first = await service.recall(ctx, 'query');
    expect(first).toEqual([]);
    expect(mnemonic.calls.filter((c) => c.tool === 'recall')).toHaveLength(1);

    // Second recall with same query should hit mnemonic again (empty not cached)
    await service.recall(ctx, 'query');
    expect(mnemonic.calls.filter((c) => c.tool === 'recall')).toHaveLength(2);
  });

  it('recall failure does not cache the error result', async () => {
    const mnemonic = createMockMnemonic({});
    // Override recall to throw. Record the call ourselves — overriding the
    // implementation bypasses the default mock's own `calls.push`.
    mnemonic.call.mockImplementationOnce(async (tool, args) => {
      mnemonic.calls.push({ tool, args });
      throw new Error('mnemonic connection failed');
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // First recall fails
    const first = await service.recall(ctx, 'query');
    expect(first).toEqual([]);

    // Second recall should try again (not cached the failure)
    const second = await service.recall(ctx, 'query');
    expect(second).toEqual([]);
    // Two recall attempts (both failed, neither cached)
    expect(mnemonic.calls.filter((c) => c.tool === 'recall')).toHaveLength(2);
  });

  it('projectless off with no cwd returns [] without calling mnemonic', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const config = {
      ...baseConfig,
      memory: { ...baseConfig.memory, projectless: 'off' as const },
    };
    const service = new MemoryService(config, mnemonic as never, store as never);

    const ctx = makeContext({ cwd: null, projectName: null });
    const result = await service.recall(ctx, 'query');
    expect(result).toEqual([]);
    expect(mnemonic.calls).toHaveLength(0);
  });
});

// ── Cache stats accuracy ────────────────────────────────────────────────────

describe('MemoryService — cache stats accuracy', () => {
  it('reports accurate note body cache stats after mixed operations', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Miss: first get
    await service.getNotes(['note-1'], ctx);
    // Hit: second get
    await service.getNotes(['note-1'], ctx);
    // Miss: different note
    await service.getNotes(['note-2'], ctx);

    const stats = service.cacheStats.noteBody;
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBeGreaterThanOrEqual(2);
  });

  it('reports accurate recall cache stats', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [{ id: 'note-1', title: 'Note', score: 0.9, vault: 'main' }],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const ctx = makeContext();

    // Miss: first recall
    await service.recall(ctx, 'query-a');
    // Hit: same query
    await service.recall(ctx, 'query-a');
    // Miss: different query
    await service.recall(ctx, 'query-b');

    const stats = service.cacheStats.recall;
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBeGreaterThanOrEqual(2);
  });
});
