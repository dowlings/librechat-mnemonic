import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import type { LibreChatStore } from '../src/librechat/mongo.js';
import { buildServer, type McpDeps } from '../src/mcp/server.js';
import { MemoryService } from '../src/memory/service.js';
import { MnemonicClient } from '../src/mnemonic/client.js';
import type {
  Span,
  SpanEndOptions,
  SpanOptions,
  Telemetry,
  TraceEndOptions,
  TraceOptions,
} from '../src/telemetry.js';

// The latency breakdown only means anything end to end: a real MemoryService
// over a real MnemonicClient (with only the MCP connection faked), driven
// through a real MCP tool call. Anything mocked in between would be mocking
// away the spans under test.

const config: AppConfig = {
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
    createProjectDirs: false,
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

interface RecordedSpan {
  options: SpanOptions;
  endArgs?: SpanEndOptions;
  ended: boolean;
  attributes: Record<string, unknown>;
  exceptions: unknown[];
  children: RecordedSpan[];
}

interface RecordedTrace {
  options: TraceOptions;
  endArgs?: TraceEndOptions;
  spans: RecordedSpan[];
}

function recordSpan(options: SpanOptions, siblings: RecordedSpan[]): Span {
  const record: RecordedSpan = {
    options,
    ended: false,
    attributes: {},
    exceptions: [],
    children: [],
  };
  siblings.push(record);
  return {
    span: (childOptions: SpanOptions) => recordSpan(childOptions, record.children),
    setAttributes: (attributes: Record<string, unknown>) =>
      void Object.assign(record.attributes, attributes),
    recordException: (error: unknown) => void record.exceptions.push(error),
    end: (endOptions?: SpanEndOptions) => {
      record.ended = true;
      record.endArgs = endOptions ?? record.endArgs;
    },
  };
}

function createRecordingTelemetry() {
  const traces: RecordedTrace[] = [];
  const telemetry: Telemetry = {
    enabled: true,
    trace(options) {
      const record: RecordedTrace = { options, spans: [] };
      traces.push(record);
      return {
        span: (spanOptions: SpanOptions) => recordSpan(spanOptions, record.spans),
        generation: () => ({ end: () => {} }),
        end: (endOptions?: TraceEndOptions) => void (record.endArgs = endOptions),
      };
    },
    flush: async () => {},
    shutdown: async () => {},
  };
  return { telemetry, traces };
}

/** The single tool span of the nth trace, with its child spans. */
function toolSpan(traces: RecordedTrace[], index = 0): RecordedSpan {
  const trace = traces[index];
  if (!trace) throw new Error(`no trace recorded at index ${index}`);
  const [span] = trace.spans;
  if (!span) throw new Error('no tool span was recorded');
  return span;
}

function childNames(span: RecordedSpan): string[] {
  return span.children.map((child) => child.options.name);
}

function child(span: RecordedSpan, name: string): RecordedSpan {
  const found = span.children.find((candidate) => candidate.options.name === name);
  if (!found) throw new Error(`no child span named ${name}; got ${childNames(span).join(', ')}`);
  return found;
}

type ToolHandler = (args: Record<string, unknown>) => unknown;

/**
 * A MnemonicClient whose MCP connection is faked. `connect` is replaced on the
 * instance, so the queue, the timeouts, and the error translation are all the
 * real ones.
 */
function createMnemonic(handlers: Record<string, ToolHandler>, connectError?: Error) {
  const mnemonic = new MnemonicClient(config);
  const callTool = vi.fn(async (request: { name: string; arguments: Record<string, unknown> }) => {
    const handler = handlers[request.name];
    if (!handler) throw new Error(`unexpected mnemonic tool ${request.name}`);
    return handler(request.arguments);
  });
  (mnemonic as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(async () => {
    if (connectError) throw connectError;
    return { callTool, close: async () => {}, onclose: null };
  });
  return { mnemonic, callTool };
}

function recallResult(results: unknown[]) {
  return {
    content: [{ type: 'text' as const, text: 'ok' }],
    structuredContent: { results },
    isError: false,
  };
}

async function connect(handlers: Record<string, ToolHandler>, connectError?: Error) {
  const { telemetry, traces } = createRecordingTelemetry();
  const { mnemonic, callTool } = createMnemonic(handlers, connectError);
  const store = {
    getConversationProject: vi.fn().mockResolvedValue(null),
    getMemorySetting: vi.fn(),
    setConversationMemory: vi.fn(),
  } as unknown as LibreChatStore;
  const memory = new MemoryService(config, mnemonic, store);
  const server = buildServer({ config, store, memory, telemetry } as McpDeps, 'user-1', 'conv-1');
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    traces,
    callTool,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

describe('MCP tool span waterfall', () => {
  let close: (() => Promise<unknown>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('breaks search_memory down into queue_wait, connect, recall, and get spans', async () => {
    const session = await connect({
      recall: () => recallResult([{ id: 'note-1', title: 'Roadmap', score: 0.9 }]),
      get: () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { notes: [{ id: 'note-1', content: 'Ships in Q3.' }] },
        isError: false,
      }),
    });
    close = session.close;

    await session.client.callTool({ name: 'search_memory', arguments: { query: 'roadmap' } });

    const tool = toolSpan(session.traces);
    expect(tool.options.name).toBe('search_memory');
    expect(new Set(childNames(tool))).toEqual(
      new Set(['queue_wait', 'connect', 'mnemonic.recall', 'mnemonic.get']),
    );

    // One queue_wait and one connect per round-trip, told apart by tool name.
    expect(childNames(tool).filter((name) => name === 'queue_wait')).toHaveLength(2);
    const queueTools = tool.children
      .filter((span) => span.options.name === 'queue_wait')
      .map((span) => span.options.metadata?.['mnemonic.tool']);
    expect(queueTools).toEqual(['recall', 'get']);

    for (const span of tool.children) {
      expect(span.ended).toBe(true);
      expect(span.exceptions).toEqual([]);
    }
  });

  it('records tool name, timeout, cache hit, and result count as attributes', async () => {
    const session = await connect({
      recall: () => recallResult([{ id: 'note-1', title: 'Roadmap', score: 0.9 }]),
      get: () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { notes: [{ id: 'note-1', content: 'Ships in Q3.' }] },
        isError: false,
      }),
    });
    close = session.close;

    await session.client.callTool({ name: 'search_memory', arguments: { query: 'roadmap' } });

    const tool = toolSpan(session.traces);
    expect(tool.attributes).toMatchObject({
      'mnemonic.cache_hit': false,
      'mnemonic.result_count': 1,
    });

    const recall = child(tool, 'mnemonic.recall');
    expect(recall.options.metadata?.['mnemonic.tool']).toBe('recall');
    expect(recall.endArgs?.metadata?.['mnemonic.result_count']).toBe(1);

    const connectSpan = child(tool, 'connect');
    expect(connectSpan.options.metadata).toMatchObject({
      'mnemonic.tool': 'recall',
      'mnemonic.timeout_ms': 20_000,
    });
  });

  it('marks a cached recall as a cache hit and skips the mnemonic spans', async () => {
    const session = await connect({
      recall: () => recallResult([{ id: 'note-1', title: 'Roadmap', score: 0.9 }]),
      get: () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { notes: [{ id: 'note-1', content: 'Ships in Q3.' }] },
        isError: false,
      }),
    });
    close = session.close;

    const args = { query: 'roadmap' };
    await session.client.callTool({ name: 'search_memory', arguments: args });
    await session.client.callTool({ name: 'search_memory', arguments: args });

    const second = toolSpan(session.traces, 1);
    expect(second.attributes).toMatchObject({
      'mnemonic.cache_hit': true,
      'mnemonic.result_count': 1,
    });
    expect(childNames(second)).toEqual([]);
  });

  it('breaks save_memory down into queue_wait, connect, dedupe, and remember spans', async () => {
    const session = await connect({
      recall: () => recallResult([]),
      remember: () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { action: 'created', id: 'note-2' },
        isError: false,
      }),
    });
    close = session.close;

    await session.client.callTool({
      name: 'save_memory',
      arguments: { title: 'Roadmap', content: 'Ships in Q3.' },
    });

    const tool = toolSpan(session.traces);
    expect(tool.options.name).toBe('save_memory');
    expect(new Set(childNames(tool))).toEqual(
      new Set(['queue_wait', 'connect', 'mnemonic.dedupe', 'mnemonic.remember']),
    );

    const dedupe = child(tool, 'mnemonic.dedupe');
    expect(dedupe.endArgs?.metadata).toMatchObject({
      'mnemonic.result_count': 0,
      'mnemonic.duplicate_count': 0,
    });
    expect(child(tool, 'mnemonic.remember').endArgs?.metadata?.['mnemonic.note_id']).toBe('note-2');
  });
});

describe('span error recording', () => {
  let close: (() => Promise<unknown>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('records the exception on the recall span when mnemonic fails', async () => {
    const session = await connect({
      recall: () => {
        throw new Error('mnemonic exploded');
      },
    });
    close = session.close;

    const result = await session.client.callTool({
      name: 'search_memory',
      arguments: { query: 'roadmap' },
    });

    // The tool still degrades gracefully...
    expect(JSON.stringify(result.content)).toContain('No matching memories.');
    // ...but the failure is on the span, not only in the log.
    const recall = child(toolSpan(session.traces), 'mnemonic.recall');
    expect(recall.exceptions).toHaveLength(1);
    expect((recall.exceptions[0] as Error).message).toContain('mnemonic exploded');
    expect(recall.endArgs?.metadata?.status).toBe('error');
  });

  it('records the exception on the get span when the note fetch fails', async () => {
    const session = await connect({
      recall: () => recallResult([{ id: 'note-1', title: 'Roadmap', score: 0.9 }]),
      get: () => {
        throw new Error('get exploded');
      },
    });
    close = session.close;

    await session.client.callTool({ name: 'search_memory', arguments: { query: 'roadmap' } });

    const get = child(toolSpan(session.traces), 'mnemonic.get');
    expect((get.exceptions[0] as Error).message).toContain('get exploded');
    expect(get.endArgs?.metadata?.status).toBe('error');
  });

  it('records the exception on the remember span and on the tool span when a save fails', async () => {
    const session = await connect({
      recall: () => recallResult([]),
      remember: () => {
        throw new Error('write exploded');
      },
    });
    close = session.close;

    await session.client.callTool({
      name: 'save_memory',
      arguments: { title: 'Roadmap', content: 'Ships in Q3.' },
    });

    const tool = toolSpan(session.traces);
    const remember = child(tool, 'mnemonic.remember');
    expect((remember.exceptions[0] as Error).message).toContain('write exploded');
    expect(remember.endArgs?.metadata?.status).toBe('error');
    // save() swallows the error into `{ saved: false, reason: 'error' }`, which
    // the tool reports as isError — the tool span has to show ERROR too.
    expect(tool.exceptions).toHaveLength(1);
    expect(tool.endArgs?.metadata?.status).toBe('error');
  });

  it('records the exception on the dedupe span but still saves', async () => {
    const session = await connect({
      recall: () => {
        throw new Error('dedupe exploded');
      },
      remember: () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { action: 'created', id: 'note-2' },
        isError: false,
      }),
    });
    close = session.close;

    const result = await session.client.callTool({
      name: 'save_memory',
      arguments: { title: 'Roadmap', content: 'Ships in Q3.' },
    });

    expect(JSON.stringify(result.content)).toContain('Saved as note-2.');
    const dedupe = child(toolSpan(session.traces), 'mnemonic.dedupe');
    expect((dedupe.exceptions[0] as Error).message).toContain('dedupe exploded');
    expect(dedupe.endArgs?.metadata?.status).toBe('error');
  });

  it('records the exception on the connect span when the connection fails', async () => {
    const session = await connect({}, new Error('mnemonic is unavailable'));
    close = session.close;

    await session.client.callTool({ name: 'search_memory', arguments: { query: 'roadmap' } });

    const tool = toolSpan(session.traces);
    const connectSpan = child(tool, 'connect');
    expect((connectSpan.exceptions[0] as Error).message).toBe('mnemonic is unavailable');
    expect(connectSpan.endArgs?.metadata?.status).toBe('error');
    // The failure propagates out of the client, so the recall span shows it too.
    expect(child(tool, 'mnemonic.recall').exceptions).toHaveLength(1);
  });
});
