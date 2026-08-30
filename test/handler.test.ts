import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { DATETIME_BLOCK_MARKER, MEMORY_BLOCK_MARKER } from '../src/proxy/inject.js';
import { createApp } from '../src/server.js';
import type {
  Generation,
  GenerationEndOptions,
  GenerationOptions,
  Span,
  Telemetry,
  TraceOptions,
} from '../src/telemetry.js';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 8710,
    host: '0.0.0.0',
    logLevel: 'silent',
    librechat: {
      mongoUri: 'mongodb://localhost',
      userHeader: 'x-librechat-user-id',
      conversationHeader: 'x-librechat-conversation-id',
    },
    upstreams: [
      {
        name: 'openai',
        baseUrl: 'https://upstream.example',
        api: 'openai',
        forceIncludeUsage: true,
      },
    ],
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
      recallEnabled: false,
      writeMode: 'off',
      maxContextChars: 4000,
      queryMessageCount: 3,
      queryMaxChars: 1500,
      maxPerTurn: 3,
      dedupeThreshold: 0.82,
      commandPrefix: '/memory',
      projectless: 'global',
    },
    prompt: { datetimeEnabled: true },
    extract: { timeoutMs: 30000 },
    mcp: { enabled: false, path: '/mcp' },
    cache: {
      noteBodyTtlMs: 300_000,
      recallTtlMs: 120_000,
      settingsTtlMs: 30_000,
      maxEntries: 5_000,
    },
    telemetry: { enabled: false, baseUrl: 'https://cloud.langfuse.com', environment: 'test' },
    ...overrides,
  };
}

interface RecordedGeneration {
  options: GenerationOptions;
  endArgs?: GenerationEndOptions;
}

const noopSpan: Span = {
  span: () => noopSpan,
  setAttributes: () => {},
  recordException: () => {},
  end: () => {},
};

function createRecordingTelemetry() {
  const traces: TraceOptions[] = [];
  const generations: RecordedGeneration[] = [];

  const telemetry: Telemetry = {
    enabled: true,
    trace(options) {
      traces.push(options);
      return {
        span: () => noopSpan,
        generation: (genOptions: GenerationOptions): Generation => {
          const record: RecordedGeneration = { options: genOptions };
          generations.push(record);
          return {
            end: (endOptions?: GenerationEndOptions) => {
              record.endArgs = endOptions;
            },
          };
        },
        end: () => {},
      };
    },
    flush: async () => {},
    shutdown: async () => {},
  };

  return { telemetry, traces, generations };
}

function createMockStore(getMemorySetting: ReturnType<typeof vi.fn>) {
  return {
    getMemorySetting,
    settingsCacheStats: { hits: 0, misses: 0, size: 0, hitRate: 0 },
  };
}

function createMockMemory(resolveContext: ReturnType<typeof vi.fn>) {
  return {
    resolveContext,
    recall: vi.fn().mockResolvedValue([]),
    save: vi.fn(),
    cacheStats: {
      noteBody: { hits: 0, misses: 0, size: 0, hitRate: 0 },
      recall: { hits: 0, misses: 0, size: 0, hitRate: 0 },
    },
  };
}

async function listen(
  app: ReturnType<typeof createApp>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join('\n')));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

describe('proxy handler usage telemetry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('records a usage-bearing generation for a turn with no conversation id (LibreChat side calls)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'a title' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const getMemorySetting = vi.fn();
    const resolveContext = vi.fn();
    const { telemetry, traces, generations } = createRecordingTelemetry();
    const app = createApp({
      config: makeConfig(),
      store: createMockStore(getMemorySetting) as never,
      memory: createMockMemory(resolveContext) as never,
      telemetry,
    });

    const { url, close } = await listen(app);
    try {
      const res = await originalFetch(`${url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);

      // Side calls have no conversation id, so memory must never be consulted.
      expect(getMemorySetting).not.toHaveBeenCalled();
      expect(resolveContext).not.toHaveBeenCalled();

      expect(traces).toHaveLength(1);
      expect(traces[0]?.metadata).toMatchObject({ hasConversation: false, memoryEnabled: false });

      expect(generations).toHaveLength(1);
      expect(generations[0]?.options).toMatchObject({ name: 'upstream', model: 'gpt-4o' });
      expect(generations[0]?.endArgs?.usage).toEqual({
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
      });
    } finally {
      await close();
    }
  });

  it('records usage even when a conversation id is present but memory is disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'hello there' } }],
        usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const getMemorySetting = vi.fn().mockResolvedValue({ enabled: false, source: 'default' });
    const resolveContext = vi.fn();
    const { telemetry, traces, generations } = createRecordingTelemetry();
    const app = createApp({
      config: makeConfig(),
      store: createMockStore(getMemorySetting) as never,
      memory: createMockMemory(resolveContext) as never,
      telemetry,
    });

    const { url, close } = await listen(app);
    try {
      const res = await originalFetch(`${url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-librechat-conversation-id': 'conv-1',
          'x-librechat-user-id': 'user-1',
        },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);

      expect(getMemorySetting).toHaveBeenCalledWith('user-1', 'conv-1');
      // Memory is off, so no context resolution or recall should happen.
      expect(resolveContext).not.toHaveBeenCalled();

      expect(traces[0]?.metadata).toMatchObject({ hasConversation: true, memoryEnabled: false });
      expect(generations[0]?.endArgs?.usage).toEqual({
        promptTokens: 6,
        completionTokens: 2,
        totalTokens: 8,
      });
    } finally {
      await close();
    }
  });

  it('forces include_usage on OpenAI streaming requests regardless of memory status', async () => {
    let sentBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}',
          '',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
          '',
          'data: [DONE]',
          '',
        ]),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { telemetry, generations } = createRecordingTelemetry();
    const app = createApp({
      config: makeConfig(),
      store: createMockStore(vi.fn()) as never,
      memory: createMockMemory(vi.fn()) as never,
      telemetry,
    });

    const { url, close } = await listen(app);
    try {
      const res = await originalFetch(`${url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);

      expect(sentBody?.stream_options).toEqual({ include_usage: true });
      expect(generations[0]?.endArgs?.usage).toEqual({
        promptTokens: 3,
        completionTokens: 1,
        totalTokens: 4,
      });
    } finally {
      await close();
    }
  });

  it('accumulates usage across message_start and message_delta for an Anthropic streaming turn', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","usage":{"output_tokens":5}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
        ]),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { telemetry, traces, generations } = createRecordingTelemetry();
    const app = createApp({
      config: makeConfig(),
      store: createMockStore(vi.fn()) as never,
      memory: createMockMemory(vi.fn()) as never,
      telemetry,
    });

    const { url, close } = await listen(app);
    try {
      const res = await originalFetch(`${url}/openai/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);

      expect(traces[0]?.metadata).toMatchObject({ format: 'anthropic', model: 'claude-sonnet-4' });
      expect(generations).toHaveLength(1);
      expect(generations[0]?.endArgs?.usage).toEqual({
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      });
    } finally {
      await close();
    }
  });

  it('logs at debug level when a streamed turn completes with no usage frame', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}', '', 'data: [DONE]', '']),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const debugSpy = vi.spyOn(logger, 'debug');

    const { telemetry } = createRecordingTelemetry();
    const app = createApp({
      config: makeConfig(),
      store: createMockStore(vi.fn()) as never,
      memory: createMockMemory(vi.fn()) as never,
      telemetry,
    });

    const { url, close } = await listen(app);
    try {
      await originalFetch(`${url}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({ upstream: 'openai' }),
        'streamed turn completed with no usage frame',
      );
    } finally {
      await close();
    }
  });
});

describe('current datetime injection', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Runs one chat turn and hands back the body that actually reached upstream. */
  async function sendTurn(options: {
    config?: AppConfig;
    path?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    memorySetting?: { enabled: boolean; source: string };
    recalled?: unknown[];
    context?: Record<string, unknown>;
  }): Promise<{ sent: Record<string, unknown>; traces: TraceOptions[] }> {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    }) as unknown as typeof fetch;

    const memory = createMockMemory(
      vi.fn().mockResolvedValue(
        options.context ?? {
          userId: 'user-1',
          conversationId: 'conv-1',
          projectName: null,
          cwd: null,
        },
      ),
    );
    if (options.recalled) memory.recall = vi.fn().mockResolvedValue(options.recalled);

    const { telemetry, traces } = createRecordingTelemetry();
    const app = createApp({
      config: options.config ?? makeConfig(),
      store: createMockStore(
        vi.fn().mockResolvedValue(options.memorySetting ?? { enabled: false, source: 'default' }),
      ) as never,
      memory: memory as never,
      telemetry,
    });

    const { url, close } = await listen(app);
    try {
      const res = await originalFetch(`${url}${options.path ?? '/openai/v1/chat/completions'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-librechat-conversation-id': 'conv-1',
          'x-librechat-user-id': 'user-1',
          ...options.headers,
        },
        body: JSON.stringify(
          options.body ?? { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
        ),
      });
      expect(res.status).toBe(200);
      return { sent, traces };
    } finally {
      await close();
    }
  }

  it('adds a system message carrying UTC and unix time, even with memory off', async () => {
    const { sent, traces } = await sendTurn({});

    const messages = sent.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain(DATETIME_BLOCK_MARKER);
    expect(messages[0]?.content).toMatch(/UTC: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(messages[0]?.content).toMatch(/Unix time: \d{10}/);
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });

    expect(traces[0]?.metadata).toMatchObject({ datetimeInjected: true, memoryEnabled: false });
  });

  it('keeps the operator system prompt first', async () => {
    const { sent } = await sendTurn({
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'operator rules' },
          { role: 'user', content: 'hi' },
        ],
      },
    });

    const messages = sent.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toBe('operator rules');
    expect(messages[1]?.content).toContain(DATETIME_BLOCK_MARKER);
  });

  it('puts the datetime ahead of the memory block, so "now" is read before anything dated', async () => {
    const config = makeConfig();
    const { sent } = await sendTurn({
      config: {
        ...config,
        memory: { ...config.memory, recallEnabled: true },
      },
      memorySetting: { enabled: true, source: 'default' },
      recalled: [
        {
          id: 'note-1',
          title: 'The NAS runs NFS v4',
          score: 0.7,
          vault: 'main-vault',
          content: 'Exports live under /mnt.',
        },
      ],
    });

    const contents = (sent.messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents[0]).toContain(DATETIME_BLOCK_MARKER);
    expect(contents[1]).toContain(MEMORY_BLOCK_MARKER);
    expect(contents[2]).toBe('hi');
  });

  it('uses the top-level system field for the Anthropic wire format', async () => {
    const { sent } = await sendTurn({
      path: '/openai/v1/messages',
      body: { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(sent.system).toContain(DATETIME_BLOCK_MARKER);
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('leaves side calls with no conversation id untouched', async () => {
    const { sent, traces } = await sendTurn({ headers: { 'x-librechat-conversation-id': '' } });

    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(traces[0]?.metadata).toMatchObject({ datetimeInjected: false });
  });

  it('injects nothing when PROMPT_DATETIME_ENABLED is off', async () => {
    const config = makeConfig();
    const { sent, traces } = await sendTurn({
      config: { ...config, prompt: { datetimeEnabled: false } },
    });

    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(traces[0]?.metadata).toMatchObject({ datetimeInjected: false });
  });
});
