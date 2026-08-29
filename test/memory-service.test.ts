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

const context = {
  userId: 'user-1',
  conversationId: 'conv-1',
  projectName: 'test-project',
  cwd: '/projects/test-project/abc123',
};

// ── Mock helpers ────────────────────────────────────────────────────────────

/** A minimal mock for MnemonicClient that records calls and returns canned data. */
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
  } = {},
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const mock = {
    call: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });

      if (tool === 'recall') {
        const results = opts.recallResults ?? [];
        return {
          structured: {
            action: 'recall',
            results,
          } as RecallResponse,
          text: '',
        } satisfies MnemonicResult<RecallResponse>;
      }

      if (tool === 'forget') {
        if (opts.forgetShouldFail) {
          throw new Error('mock forget failure');
        }
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
        const notes = ids.map((id) => ({
          id,
          title: `Note ${id}`,
          content: `Content for ${id}`,
          tags: [],
          lifecycle: 'permanent',
        }));
        return { structured: { action: 'get', notes } as GetResponse, text: '' };
      }

      return { structured: undefined, text: '' };
    }),
    calls,
  };

  return mock;
}

/** A minimal mock for LibreChatStore — only resolveContext is used in save(). */
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

function makeResult(
  id: string,
  title: string,
  score: number,
  tags: string[] = [],
): { id: string; title: string; score: number; tags: string[]; vault: string } {
  return { id, title, score, tags, vault: 'main' };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('MemoryService.save — dedupe behaviour', () => {
  it('saves when no duplicates exist', async () => {
    const mnemonic = createMockMnemonic({ recallResults: [] });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'New decision',
      content: 'We decided to use Ollama for embeddings.',
      role: 'decision',
    });

    expect(result.saved).toBe(true);
    expect(result.id).toBe('new-note-id');
    expect(mnemonic.calls.filter((c) => c.tool === 'remember')).toHaveLength(1);
    expect(mnemonic.calls.filter((c) => c.tool === 'forget')).toHaveLength(0);
  });

  it('explicit save replaces a single auto-extracted fragment', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [makeResult('auto-1', 'Auto fragment about Ollama', 0.88, ['auto-extracted'])],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Decision: use Ollama for embeddings',
      content: 'We decided to use Ollama for local embeddings on the NAS.',
      role: 'decision',
    });

    expect(result.saved).toBe(true);
    // Should have forgotten the auto-extracted fragment
    const forgetCalls = mnemonic.calls.filter((c) => c.tool === 'forget');
    expect(forgetCalls).toHaveLength(1);
    expect(forgetCalls[0]!.args.id).toBe('auto-1');
    // Should have saved the explicit note
    expect(mnemonic.calls.filter((c) => c.tool === 'remember')).toHaveLength(1);
  });

  it('explicit save replaces multiple auto-extracted fragments (loop)', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [
        makeResult('auto-1', 'Ollama embeddings decision', 0.85, ['auto-extracted']),
        makeResult('auto-2', 'NAS GPU for Ollama', 0.84, ['auto-extracted']),
        makeResult('auto-3', 'nomic-embed-text model', 0.82, ['auto-extracted']),
      ],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Decision: use Ollama for local embeddings on the NAS',
      content:
        'We decided to use Ollama for local embeddings on the NAS with nomic-embed-text-v2-moe, using the GTX 1660 Super GPU.',
      role: 'decision',
    });

    expect(result.saved).toBe(true);
    const forgetCalls = mnemonic.calls.filter((c) => c.tool === 'forget');
    expect(forgetCalls).toHaveLength(3);
    const forgottenIds = forgetCalls.map((c) => c.args.id);
    expect(forgottenIds).toContain('auto-1');
    expect(forgottenIds).toContain('auto-2');
    expect(forgottenIds).toContain('auto-3');
  });

  it('explicit save is blocked by an existing explicit (non-auto-extracted) duplicate', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [
        makeResult('explicit-1', 'Decision: use Ollama for embeddings', 0.92, ['librechat']),
      ],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Decision: use Ollama for embeddings',
      content: 'We decided to use Ollama for local embeddings.',
      role: 'decision',
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(result.id).toBe('explicit-1');
    // Should NOT forget the existing explicit note
    expect(mnemonic.calls.filter((c) => c.tool === 'forget')).toHaveLength(0);
    // Should NOT save
    expect(mnemonic.calls.filter((c) => c.tool === 'remember')).toHaveLength(0);
  });

  it('explicit save with mix: forgets auto-extracted, blocks on explicit duplicate', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [
        makeResult('auto-1', 'Ollama embeddings snippet', 0.86, ['auto-extracted']),
        makeResult('explicit-1', 'Decision: use Ollama for embeddings', 0.9, ['librechat']),
      ],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Decision: use Ollama for embeddings',
      content: 'We decided to use Ollama for local embeddings.',
      role: 'decision',
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(result.id).toBe('explicit-1');
    // Should have forgotten the auto-extracted fragment
    const forgetCalls = mnemonic.calls.filter((c) => c.tool === 'forget');
    expect(forgetCalls).toHaveLength(1);
    expect(forgetCalls[0]!.args.id).toBe('auto-1');
    // Should NOT save (blocked by explicit duplicate)
    expect(mnemonic.calls.filter((c) => c.tool === 'remember')).toHaveLength(0);
  });

  it('auto-extracted save is blocked by an existing auto-extracted duplicate', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [makeResult('auto-1', 'Ollama embeddings snippet', 0.88, ['auto-extracted'])],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Ollama embeddings snippet',
      content: 'Using Ollama for embeddings.',
      tags: ['auto-extracted'],
      role: 'context',
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(result.id).toBe('auto-1');
    // Should NOT forget the existing auto-extracted note
    expect(mnemonic.calls.filter((c) => c.tool === 'forget')).toHaveLength(0);
  });

  it('auto-extracted save is blocked by an existing explicit duplicate', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [
        makeResult('explicit-1', 'Decision: use Ollama for embeddings', 0.91, ['librechat']),
      ],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Ollama embeddings snippet',
      content: 'Using Ollama for embeddings.',
      tags: ['auto-extracted'],
      role: 'context',
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('duplicate');
    expect(result.id).toBe('explicit-1');
    // Should NOT forget the existing explicit note
    expect(mnemonic.calls.filter((c) => c.tool === 'forget')).toHaveLength(0);
  });

  it('continues saving if forget fails (failed forget is a smaller problem than a lost explicit save)', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [makeResult('auto-1', 'Ollama embeddings snippet', 0.87, ['auto-extracted'])],
      forgetShouldFail: true,
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    const result = await service.save(context, {
      title: 'Decision: use Ollama for embeddings',
      content: 'We decided to use Ollama for local embeddings.',
      role: 'decision',
    });

    // Should still save even though forget failed
    expect(result.saved).toBe(true);
    expect(mnemonic.calls.filter((c) => c.tool === 'remember')).toHaveLength(1);
  });

  it('passes the tag from config to remember', async () => {
    const mnemonic = createMockMnemonic({ recallResults: [] });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    await service.save(context, {
      title: 'New note',
      content: 'Content here.',
      tags: ['custom-tag'],
    });

    const rememberCall = mnemonic.calls.find((c) => c.tool === 'remember');
    expect(rememberCall).toBeDefined();
    expect(rememberCall!.args.tags).toEqual(['custom-tag', 'librechat']);
  });

  it('passes lifecycle and role to remember', async () => {
    const mnemonic = createMockMnemonic({ recallResults: [] });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    await service.save(context, {
      title: 'Plan note',
      content: 'A plan to do something.',
      lifecycle: 'temporary',
      role: 'plan',
    });

    const rememberCall = mnemonic.calls.find((c) => c.tool === 'remember');
    expect(rememberCall).toBeDefined();
    expect(rememberCall!.args.lifecycle).toBe('temporary');
    expect(rememberCall!.args.role).toBe('plan');
  });
});

// ── Cache behaviour tests ───────────────────────────────────────────────────

describe('MemoryService.recall — cache behaviour', () => {
  it('caches recall results and avoids a second mnemonic round-trip', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [makeResult('note-1', 'Test note', 0.9)],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    // First call hits mnemonic
    const first = await service.recall(context, 'test query');
    expect(first).toHaveLength(1);
    const recallCallsAfterFirst = mnemonic.calls.filter((c) => c.tool === 'recall').length;
    expect(recallCallsAfterFirst).toBe(1);

    // Second call with the same query should hit the cache
    const second = await service.recall(context, 'test query');
    expect(second).toHaveLength(1);
    const recallCallsAfterSecond = mnemonic.calls.filter((c) => c.tool === 'recall').length;
    expect(recallCallsAfterSecond).toBe(1); // no new recall call
  });

  it('caches note bodies and avoids repeated get calls', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [makeResult('note-1', 'Test note', 0.9)],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    // First recall fetches bodies via get
    await service.recall(context, 'query one');
    const getCallsAfterFirst = mnemonic.calls.filter((c) => c.tool === 'get').length;
    expect(getCallsAfterFirst).toBe(1);

    // The body is now cached — a direct getNotes call for the same id should
    // be a full cache hit and make no further get call.
    mnemonic.calls.length = 0; // reset call log
    await service.getNotes(['note-1'], context);
    const getCalls = mnemonic.calls.filter((c) => c.tool === 'get').length;
    expect(getCalls).toBe(0);

    // Calling it again should still be fully cached.
    await service.getNotes(['note-1'], context);
    const getCallsSecond = mnemonic.calls.filter((c) => c.tool === 'get').length;
    expect(getCallsSecond).toBe(0); // no new get call
  });

  it('reports cache stats', async () => {
    const mnemonic = createMockMnemonic({
      recallResults: [makeResult('note-1', 'Test note', 0.9)],
    });
    const store = createMockStore();
    const service = new MemoryService(baseConfig, mnemonic as never, store as never);

    await service.recall(context, 'test query');
    await service.recall(context, 'test query'); // cache hit

    const stats = service.cacheStats;
    expect(stats.recall.hits).toBeGreaterThanOrEqual(1);
  });
});
