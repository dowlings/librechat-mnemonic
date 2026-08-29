import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { buildServer, type McpDeps } from '../src/mcp/server.js';
import type {
  Span,
  SpanEndOptions,
  SpanOptions,
  Telemetry,
  TraceEndOptions,
  TraceOptions,
} from '../src/telemetry.js';

// The MCP tools are exercised end to end through an in-memory client/server
// pair so the recorded telemetry is whatever a real tool call produces.

const config = {
  librechat: {
    userHeader: 'x-librechat-user-id',
    conversationHeader: 'x-librechat-conversation-id',
  },
  mnemonic: { writeScope: 'global', recallScope: 'all' },
} as AppConfig;

interface RecordedSpan {
  options: SpanOptions;
  endArgs?: SpanEndOptions;
}

interface RecordedTrace {
  options: TraceOptions;
  endArgs?: TraceEndOptions;
  spans: RecordedSpan[];
}

function createRecordingTelemetry() {
  const traces: RecordedTrace[] = [];

  const telemetry: Telemetry = {
    enabled: true,
    trace(options) {
      const record: RecordedTrace = { options, spans: [] };
      traces.push(record);
      return {
        span: (spanOptions: SpanOptions): Span => {
          const spanRecord: RecordedSpan = { options: spanOptions };
          record.spans.push(spanRecord);
          return { end: (endOptions?: SpanEndOptions) => void (spanRecord.endArgs = endOptions) };
        },
        generation: () => ({ end: () => {} }),
        end: (endOptions?: TraceEndOptions) => void (record.endArgs = endOptions),
      };
    },
    flush: async () => {},
    shutdown: async () => {},
  };

  return { telemetry, traces };
}

function onlyTrace(traces: RecordedTrace[]): RecordedTrace {
  const [trace] = traces;
  if (!trace) throw new Error('no trace was recorded');
  return trace;
}

function onlySpan(trace: RecordedTrace): RecordedSpan {
  const [span] = trace.spans;
  if (!span) throw new Error('no span was recorded');
  return span;
}

async function connect(deps: Partial<McpDeps>) {
  const { telemetry, traces } = createRecordingTelemetry();
  const server = buildServer(
    {
      config,
      store: { getMemorySetting: vi.fn(), setConversationMemory: vi.fn() } as never,
      memory: { resolveContext: vi.fn().mockResolvedValue({ projectName: 'demo' }) } as never,
      telemetry,
      ...deps,
    } as McpDeps,
    'user-1',
    'conv-1',
  );
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, traces, close: () => Promise.all([client.close(), server.close()]) };
}

describe('MCP tool telemetry', () => {
  let close: (() => Promise<unknown>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('records the tool arguments as input and the result text as output', async () => {
    const recall = vi
      .fn()
      .mockResolvedValue([
        { id: 'note-1', title: 'Roadmap', content: 'Ships in Q3.', project: { name: 'demo' } },
      ]);
    const session = await connect({
      memory: {
        resolveContext: vi.fn().mockResolvedValue({ projectName: 'demo' }),
        recall,
      } as never,
    });
    close = session.close;

    await session.client.callTool({
      name: 'search_memory',
      arguments: { query: 'roadmap', limit: 3 },
    });

    expect(session.traces).toHaveLength(1);
    const trace = onlyTrace(session.traces);
    expect(trace.options.name).toBe('mcp-tool');
    expect(trace.options.input).toEqual({ query: 'roadmap', limit: 3 });
    expect(trace.endArgs?.output).toContain('Ships in Q3.');

    expect(trace.spans).toHaveLength(1);
    const span = onlySpan(trace);
    expect(span.options.name).toBe('search_memory');
    expect(span.options.input).toEqual({ query: 'roadmap', limit: 3 });
    expect(span.endArgs?.output).toContain('Ships in Q3.');
    expect(span.endArgs?.metadata).toEqual({ status: 'ok' });
  });

  it('records the failure text as output when a tool reports an error', async () => {
    const session = await connect({});
    close = session.close;

    await session.client.callTool({
      name: 'save_memory',
      arguments: { title: 'x'.repeat(201), content: 'body' },
    });

    const trace = onlyTrace(session.traces);
    const span = onlySpan(trace);
    expect(span.endArgs?.metadata?.status).toBe('error');
    expect(String(span.endArgs?.output)).toContain('title exceeds 200 character limit');
    expect(String(trace.endArgs?.output)).toContain('title exceeds 200 character limit');
  });

  it('records the thrown message as output when a tool throws', async () => {
    const session = await connect({
      memory: {
        resolveContext: vi.fn().mockRejectedValue(new Error('mongo down')),
      } as never,
    });
    close = session.close;

    await session.client.callTool({ name: 'forget_memory', arguments: { id: 'note-1' } });

    const trace = onlyTrace(session.traces);
    const span = onlySpan(trace);
    expect(span.endArgs?.metadata).toEqual({ status: 'error', error: 'mongo down' });
    expect(span.endArgs?.output).toEqual({ error: 'mongo down' });
    expect(trace.endArgs?.output).toEqual({ error: 'mongo down' });
  });
});
