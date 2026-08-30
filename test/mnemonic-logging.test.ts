import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { MnemonicClient, isMnemonicTimeout } from '../src/mnemonic/client.js';

/**
 * The point of these tests is the diagnosis, not the prose: a call that times
 * out has to say *which phase* it spent its time in, because that is the whole
 * difference between "mnemonic is slow", "the connection is broken" and "this
 * service serialised itself into a queue".
 */

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
    timeoutMs: 20_000,
    tag: 'librechat',
    slowCallMs: 5_000,
    statsIntervalMs: 0,
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
  extract: { timeoutMs: 30_000 },
  mcp: { enabled: true, path: '/mcp' },
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

interface CallBehaviour {
  /** How long the fake mnemonic takes to answer, per tool. */
  delayMs?: number;
  /**
   * Per-invocation delays, consumed in order and falling back to `delayMs`
   * once exhausted. Needed to make one phase clearly dominate another: with a
   * single delay a queued call waits about as long as it then runs for, and
   * which of the two is "slowest" comes down to timer jitter.
   */
  delaysMs?: number[];
  /** Thrown instead of answering. */
  fail?: () => unknown;
}

function configWith(overrides: Partial<AppConfig['mnemonic']>): AppConfig {
  return { ...baseConfig, mnemonic: { ...baseConfig.mnemonic, ...overrides } };
}

/**
 * A client whose MCP connection is faked but whose queueing, timing and
 * reporting are the real thing — those are what is under test.
 */
function createClient(config: AppConfig, behaviour: CallBehaviour = {}) {
  const client = new MnemonicClient(config);
  const delays = [...(behaviour.delaysMs ?? [])];
  const fakeClient = {
    callTool: vi.fn(async () => {
      const delayMs = delays.shift() ?? behaviour.delayMs;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (behaviour.fail) throw behaviour.fail();
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { results: [] },
        isError: false,
      };
    }),
    close: vi.fn(async () => {}),
    onclose: null,
  };
  (client as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(
    async () => fakeClient,
  );
  return { client, fakeClient };
}

/** An MCP request timeout, as the SDK raises it. */
function mcpTimeout(): Error {
  const error = new Error('MCP error -32001: Request timed out');
  (error as unknown as { code: number }).code = -32001;
  return error;
}

function lastCall(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as Record<string, unknown>;
}

let debugSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isMnemonicTimeout', () => {
  it('recognises the MCP request-timeout code', () => {
    expect(isMnemonicTimeout(mcpTimeout())).toBe(true);
  });

  it('recognises the maximum-total-timeout message without the code', () => {
    expect(isMnemonicTimeout(new Error('Maximum total timeout exceeded'))).toBe(true);
  });

  it('does not claim an ordinary failure was a timeout', () => {
    expect(isMnemonicTimeout(new Error('ENOENT: no such file'))).toBe(false);
    expect(isMnemonicTimeout(null)).toBe(false);
    expect(isMnemonicTimeout('timed out')).toBe(false);
  });
});

describe('MnemonicClient — per-call logging', () => {
  it('logs a phase breakdown for a completed call', async () => {
    const { client } = createClient(baseConfig, { delayMs: 5 });

    await client.call('recall', { query: 'a' });

    const completions = debugSpy.mock.calls.filter((call) => call[1] === 'mnemonic call complete');
    expect(completions).toHaveLength(1);
    const detail = completions[0]![0] as Record<string, unknown>;
    expect(detail).toMatchObject({ tool: 'recall', queue: 'read', outcome: 'ok', queueDepth: 0 });
    expect(detail.totalMs).toBeGreaterThanOrEqual(detail.callMs as number);
    expect(detail.queueWaitMs).toBeDefined();
    expect(detail.connectMs).toBeDefined();
    // Nothing else was running, so the mnemonic round-trip is the whole cost.
    expect(detail.phase).toBe('mnemonic');

    await client.close();
  });

  it('blames the queue when a call spent its time waiting behind another', async () => {
    // A slow first call and a fast second one: the second's own round-trip is
    // negligible, so anything it spent is queue wait and nothing else.
    const { client } = createClient(baseConfig, { delaysMs: [120, 1] });

    await Promise.all([
      client.call('recall', { query: 'a' }),
      client.call('recall', { query: 'b' }),
    ]);

    const completions = debugSpy.mock.calls
      .filter((call) => call[1] === 'mnemonic call complete')
      .map((call) => call[0] as Record<string, unknown>);
    expect(completions).toHaveLength(2);

    const second = completions.find((detail) => detail.queueDepth === 1);
    expect(second).toBeDefined();
    expect(second!.queueWaitMs as number).toBeGreaterThanOrEqual(50);
    expect(second!.queueWaitMs as number).toBeGreaterThan(second!.callMs as number);
    expect(second!.phase).toBe('queue');

    await client.close();
  });

  it('warns about a slow call instead of hiding it at debug', async () => {
    const { client } = createClient(configWith({ slowCallMs: 20 }), { delayMs: 60 });

    await client.call('recall', { query: 'a' });

    const slow = warnSpy.mock.calls.filter((call) => call[1] === 'slow mnemonic call');
    expect(slow).toHaveLength(1);
    expect(slow[0]![0]).toMatchObject({ tool: 'recall', outcome: 'ok', phase: 'mnemonic' });

    await client.close();
  });

  it('warns while a call is still running, before it can time out', async () => {
    const { client } = createClient(configWith({ slowCallMs: 20 }), { delayMs: 80 });

    await client.call('recall', { query: 'a' });

    const inFlight = warnSpy.mock.calls.filter(
      (call) => call[1] === 'mnemonic call still in flight',
    );
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]![0]).toMatchObject({ tool: 'recall', phase: 'mnemonic' });

    await client.close();
  });

  it('does not warn about a call that finishes in time', async () => {
    const { client } = createClient(configWith({ slowCallMs: 5_000 }), { delayMs: 5 });

    await client.call('recall', { query: 'a' });

    expect(warnSpy).not.toHaveBeenCalled();

    await client.close();
  });

  it('reports a timeout at error level with the phase that consumed the time', async () => {
    const { client } = createClient(baseConfig, { delayMs: 5, fail: mcpTimeout });

    await expect(client.call('recall', { query: 'a' })).rejects.toThrow(/timed out/);

    const timeouts = errorSpy.mock.calls.filter((call) => call[1] === 'mnemonic call timed out');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]![0]).toMatchObject({
      tool: 'recall',
      outcome: 'timeout',
      phase: 'mnemonic',
      timeoutMs: 20_000,
    });

    await client.close();
  });

  it('separates a tool error from a timeout', async () => {
    const { client } = createClient(baseConfig, {
      fail: () => new Error('vault is corrupt'),
    });

    await expect(client.call('recall', { query: 'a' })).rejects.toThrow('vault is corrupt');

    const detail = lastCall(warnSpy);
    expect(detail).toMatchObject({ outcome: 'error', tool: 'recall' });
    expect(errorSpy).not.toHaveBeenCalled();

    await client.close();
  });

  it('classifies a mnemonic-reported tool failure as a tool error', async () => {
    const client = new MnemonicClient(baseConfig);
    (client as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(async () => ({
      callTool: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'unknown note id' }],
        isError: true,
      })),
    }));

    await expect(client.call('get', { ids: ['nope'] })).rejects.toThrow(/unknown note id/);

    expect(lastCall(warnSpy)).toMatchObject({ outcome: 'tool_error', tool: 'get' });

    await client.close();
  });

  it('reports a call that never reached mnemonic as pure queue time', async () => {
    const client = new MnemonicClient(baseConfig);
    (client as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(async () => {
      throw new Error('mnemonic is unavailable (circuit open)');
    });

    await expect(client.call('recall', { query: 'a' })).rejects.toThrow(/circuit open/);

    const detail = lastCall(warnSpy);
    expect(detail).toMatchObject({ outcome: 'unavailable' });
    // The call never got past connect, so there is no mnemonic phase to blame.
    expect(detail.callMs).toBeUndefined();

    await client.close();
  });
});

describe('MnemonicClient — stats', () => {
  it('accumulates per-tool counters across calls', async () => {
    const { client } = createClient(baseConfig, { delayMs: 2 });

    await client.call('recall', { query: 'a' });
    await client.call('recall', { query: 'b' });
    await client.call('remember', { title: 't', content: 'c' });

    const stats = client.stats;
    expect(stats.tools.recall).toMatchObject({ calls: 2, errors: 0, timeouts: 0 });
    expect(stats.tools.remember).toMatchObject({ calls: 1 });
    expect(stats.tools.recall!.maxMs).toBeGreaterThanOrEqual(0);
    expect(stats.connected).toBe(false); // connect() is faked, so nothing is cached
    expect(stats.inFlight).toEqual({ read: 0, write: 0 });
    expect(stats.timeoutMs).toBe(20_000);

    await client.close();
  });

  it('counts timeouts separately from other errors', async () => {
    const { client } = createClient(baseConfig, { fail: mcpTimeout });
    await expect(client.call('recall', {})).rejects.toThrow();

    const { client: failing } = createClient(baseConfig, {
      fail: () => new Error('boom'),
    });
    await expect(failing.call('recall', {})).rejects.toThrow();

    expect(client.stats.tools.recall).toMatchObject({ calls: 1, errors: 1, timeouts: 1 });
    expect(failing.stats.tools.recall).toMatchObject({ calls: 1, errors: 1, timeouts: 0 });

    await client.close();
    await failing.close();
  });

  it('records the worst queue wait a tool has seen', async () => {
    const { client } = createClient(baseConfig, { delayMs: 40 });

    await Promise.all([client.call('recall', {}), client.call('recall', {})]);

    expect(client.stats.tools.recall!.maxQueueWaitMs).toBeGreaterThanOrEqual(30);

    await client.close();
  });
});
