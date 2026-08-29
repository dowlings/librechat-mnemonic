import { LangfuseOtelSpanAttributes } from '@langfuse/core';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTelemetry, LangfuseTelemetry, type Telemetry } from '../src/telemetry.js';

// The factory and noop paths need no Langfuse credentials. The real v5 path is
// exercised through LangfuseTelemetry with an in-memory OTel exporter in place
// of the LangfuseSpanProcessor, so nothing leaves the process.

describe('createTelemetry', () => {
  it('returns noop telemetry when disabled', () => {
    const telemetry = createTelemetry({
      enabled: false,
      baseUrl: 'https://cloud.langfuse.com',
    });
    expect(telemetry.enabled).toBe(false);
  });

  it('returns noop telemetry when public key is missing', () => {
    const telemetry = createTelemetry({
      enabled: true,
      secretKey: 'sk-test',
      baseUrl: 'https://cloud.langfuse.com',
    });
    expect(telemetry.enabled).toBe(false);
  });

  it('returns noop telemetry when secret key is missing', () => {
    const telemetry = createTelemetry({
      enabled: true,
      publicKey: 'pk-test',
      baseUrl: 'https://cloud.langfuse.com',
    });
    expect(telemetry.enabled).toBe(false);
  });

  it('returns noop telemetry when both keys are missing', () => {
    const telemetry = createTelemetry({
      enabled: true,
      baseUrl: 'https://cloud.langfuse.com',
    });
    expect(telemetry.enabled).toBe(false);
  });
});

describe('NoopTelemetry', () => {
  let telemetry: Telemetry;

  beforeEach(() => {
    telemetry = createTelemetry({
      enabled: false,
      baseUrl: 'https://cloud.langfuse.com',
    });
  });

  it('trace returns a non-throwing trace object', () => {
    const trace = telemetry.trace({
      name: 'test',
      sessionId: 's1',
      userId: 'u1',
    });
    expect(trace).toBeDefined();
    expect(typeof trace.span).toBe('function');
    expect(typeof trace.end).toBe('function');
  });

  it('span returns a non-throwing span object', () => {
    const trace = telemetry.trace({ name: 'test' });
    const span = trace.span({ name: 'test-span' });
    expect(span).toBeDefined();
    expect(typeof span.end).toBe('function');
    // end should not throw
    expect(() => span.end()).not.toThrow();
    expect(() => span.end({ metadata: { foo: 'bar' }, output: { ok: true } })).not.toThrow();
  });

  it('span children, attributes, and exceptions are non-throwing', () => {
    const span = telemetry.trace({ name: 'test' }).span({ name: 'test-span' });
    const child = span.span({ name: 'queue_wait' });
    expect(() => child.setAttributes({ 'mnemonic.tool': 'recall' })).not.toThrow();
    expect(() => child.recordException(new Error('boom'))).not.toThrow();
    expect(() => child.span({ name: 'deeper' }).end()).not.toThrow();
    expect(() => child.end()).not.toThrow();
  });

  it('generation returns a non-throwing generation object', () => {
    const trace = telemetry.trace({ name: 'test' });
    const generation = trace.generation({ name: 'upstream', model: 'gpt-4o' });
    expect(generation).toBeDefined();
    expect(typeof generation.end).toBe('function');
    expect(() => generation.end()).not.toThrow();
    expect(() =>
      generation.end({ usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }),
    ).not.toThrow();
  });

  it('trace.end does not throw', () => {
    const trace = telemetry.trace({ name: 'test' });
    expect(() => trace.end()).not.toThrow();
  });

  it('flush resolves without error', async () => {
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });

  it('shutdown resolves without error', async () => {
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it('creating many traces, spans, and generations does not throw or accumulate state', () => {
    for (let i = 0; i < 100; i++) {
      const trace = telemetry.trace({ name: `trace-${i}` });
      const span = trace.span({ name: `span-${i}`, input: { index: i } });
      span.end({ metadata: { index: i }, output: `done-${i}` });
      const generation = trace.generation({ name: `gen-${i}`, model: 'gpt-4o' });
      generation.end({ usage: { promptTokens: i, completionTokens: i, totalTokens: i * 2 } });
      trace.end({ output: `trace-${i}` });
    }
    // If we got here without throwing, the test passes.
    expect(true).toBe(true);
  });
});

describe('LangfuseTelemetry', () => {
  let exporter: InMemorySpanExporter;
  let telemetry: LangfuseTelemetry;

  const byName = (name: string): ReadableSpan => {
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === name);
    if (!span) throw new Error(`no exported span named ${name}`);
    return span;
  };

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    telemetry = new LangfuseTelemetry(new SimpleSpanProcessor(exporter));
  });

  afterEach(async () => {
    await telemetry.shutdown();
  });

  it('is enabled', () => {
    expect(telemetry.enabled).toBe(true);
  });

  it('gives the trace root span an end time', () => {
    const trace = telemetry.trace({ name: 'chat-turn' });
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    trace.end();

    const root = byName('chat-turn');
    expect(root.ended).toBe(true);
    expect(root.endTime[0]).toBeGreaterThan(0);
    expect(root.parentSpanContext).toBeUndefined();
  });

  it('writes session, user, and metadata as trace-level attributes', () => {
    const trace = telemetry.trace({
      name: 'chat-turn',
      sessionId: 'conv-1',
      userId: 'user-1',
      metadata: { memory: true, upstream: 'openai', counts: { recalled: 3 } },
    });
    trace.end();

    const { attributes } = byName('chat-turn');
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_NAME]).toBe('chat-turn');
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_SESSION_ID]).toBe('conv-1');
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_USER_ID]).toBe('user-1');
    expect(attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.memory`]).toBe('true');
    expect(attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.upstream`]).toBe('openai');
    expect(attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.counts`]).toBe(
      '{"recalled":3}',
    );
  });

  it('does not duplicate trace metadata as observation metadata on the root span', () => {
    const trace = telemetry.trace({
      name: 'chat-turn',
      metadata: { memory: true },
    });
    trace.end();

    const { attributes } = byName('chat-turn');
    expect(attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.memory`]).toBe('true');
    expect(attributes[`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.memory`]).toBeUndefined();
  });

  it('omits session and user attributes when not supplied', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    trace.end();

    const { attributes } = byName('mcp-tool');
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_SESSION_ID]).toBeUndefined();
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_USER_ID]).toBeUndefined();
  });

  it('parents child spans to the trace root and records end metadata', () => {
    const trace = telemetry.trace({ name: 'chat-turn' });
    const span = trace.span({ name: 'recall', metadata: { project: 'demo' } });
    span.end({ metadata: { hits: 2 } });
    trace.end();

    const root = byName('chat-turn');
    const recall = byName('recall');
    expect(recall.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(recall.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(recall.ended).toBe(true);
    expect(recall.attributes[LangfuseOtelSpanAttributes.OBSERVATION_TYPE]).toBe('span');
    expect(recall.attributes[`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.project`]).toBe(
      'demo',
    );
    expect(recall.attributes[`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.hits`]).toBe('2');
  });

  it('parents a nested span to its parent span, not to the trace root', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    const tool = trace.span({ name: 'search_memory' });
    const queue = tool.span({ name: 'queue_wait' });
    queue.end();
    tool.end();
    trace.end();

    const root = byName('mcp-tool');
    const toolSpan = byName('search_memory');
    const queueSpan = byName('queue_wait');
    expect(toolSpan.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(queueSpan.parentSpanContext?.spanId).toBe(toolSpan.spanContext().spanId);
    expect(queueSpan.spanContext().traceId).toBe(root.spanContext().traceId);
  });

  it('writes span attributes as observation metadata', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    const span = trace.span({ name: 'search_memory' });
    span.setAttributes({ 'mnemonic.cache_hit': false });
    span.setAttributes({ 'mnemonic.result_count': 3 });
    span.end();
    trace.end();

    const { attributes } = byName('search_memory');
    const metadata = LangfuseOtelSpanAttributes.OBSERVATION_METADATA;
    expect(attributes[`${metadata}.mnemonic.cache_hit`]).toBe('false');
    expect(attributes[`${metadata}.mnemonic.result_count`]).toBe('3');
  });

  it('records an exception as an ERROR status, level, and span event', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    const span = trace.span({ name: 'mnemonic.recall' });
    span.recordException(new Error('mnemonic exploded'));
    span.end({ metadata: { status: 'error' } });
    trace.end();

    const recall = byName('mnemonic.recall');
    expect(recall.status.code).toBe(SpanStatusCode.ERROR);
    expect(recall.status.message).toBe('mnemonic exploded');
    expect(recall.attributes[LangfuseOtelSpanAttributes.OBSERVATION_LEVEL]).toBe('ERROR');
    expect(recall.attributes[LangfuseOtelSpanAttributes.OBSERVATION_STATUS_MESSAGE]).toBe(
      'mnemonic exploded',
    );
    expect(recall.events.map((event) => event.name)).toContain('exception');
  });

  it('records a non-Error exception without an exception event', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    const span = trace.span({ name: 'mnemonic.recall' });
    span.recordException('plain string failure');
    span.end();
    trace.end();

    const recall = byName('mnemonic.recall');
    expect(recall.status.code).toBe(SpanStatusCode.ERROR);
    expect(recall.status.message).toBe('plain string failure');
    expect(recall.events).toHaveLength(0);
  });

  it('records span input and output as observation attributes', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    const span = trace.span({ name: 'search_memory', input: { query: 'roadmap', limit: 3 } });
    span.end({ metadata: { status: 'ok' }, output: '## Roadmap\nships in Q3' });
    trace.end();

    const { attributes } = byName('search_memory');
    expect(attributes[LangfuseOtelSpanAttributes.OBSERVATION_INPUT]).toBe(
      '{"query":"roadmap","limit":3}',
    );
    expect(attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT]).toBe(
      '## Roadmap\nships in Q3',
    );
  });

  it('records trace input and output as trace attributes', () => {
    const trace = telemetry.trace({ name: 'mcp-tool', input: { query: 'roadmap' } });
    trace.end({ output: 'No matching memories.' });

    const { attributes } = byName('mcp-tool');
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_INPUT]).toBe('{"query":"roadmap"}');
    expect(attributes[LangfuseOtelSpanAttributes.TRACE_OUTPUT]).toBe('No matching memories.');
  });

  it('omits input and output attributes when not supplied', () => {
    const trace = telemetry.trace({ name: 'chat-turn' });
    const span = trace.span({ name: 'recall' });
    span.end();
    trace.end();

    const root = byName('chat-turn');
    const recall = byName('recall');
    expect(root.attributes[LangfuseOtelSpanAttributes.TRACE_INPUT]).toBeUndefined();
    expect(root.attributes[LangfuseOtelSpanAttributes.TRACE_OUTPUT]).toBeUndefined();
    expect(recall.attributes[LangfuseOtelSpanAttributes.OBSERVATION_INPUT]).toBeUndefined();
    expect(recall.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT]).toBeUndefined();
  });

  it('stamps the configured environment on every observation', async () => {
    const scopedExporter = new InMemorySpanExporter();
    const scoped = new LangfuseTelemetry(new SimpleSpanProcessor(scopedExporter), 'production');
    try {
      const trace = scoped.trace({ name: 'mcp-tool' });
      trace.span({ name: 'search_memory' }).end();
      trace.generation({ name: 'upstream', model: 'gpt-4o' }).end();
      trace.end();

      const spans = scopedExporter.getFinishedSpans();
      expect(spans.map((span) => span.name).sort()).toEqual([
        'mcp-tool',
        'search_memory',
        'upstream',
      ]);
      for (const span of spans) {
        expect(span.attributes[LangfuseOtelSpanAttributes.ENVIRONMENT]).toBe('production');
      }
    } finally {
      await scoped.shutdown();
    }
  });

  it('leaves the environment unset when none is configured', () => {
    const trace = telemetry.trace({ name: 'mcp-tool' });
    trace.end();

    expect(byName('mcp-tool').attributes[LangfuseOtelSpanAttributes.ENVIRONMENT]).toBeUndefined();
  });

  it('records generations with model and usage details', () => {
    const trace = telemetry.trace({ name: 'chat-turn' });
    const generation = trace.generation({ name: 'upstream', model: 'gpt-4o' });
    generation.end({
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      metadata: { stream: true },
    });
    trace.end();

    const upstream = byName('upstream');
    expect(upstream.attributes[LangfuseOtelSpanAttributes.OBSERVATION_TYPE]).toBe('generation');
    expect(upstream.attributes[LangfuseOtelSpanAttributes.OBSERVATION_MODEL]).toBe('gpt-4o');
    expect(upstream.attributes[LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS]).toBe(
      '{"input":11,"output":7,"total":18}',
    );
    expect(upstream.attributes[`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.stream`]).toBe(
      'true',
    );
  });

  it('omits usage details when the upstream reported none', () => {
    const trace = telemetry.trace({ name: 'chat-turn' });
    trace.generation({ name: 'upstream', model: 'gpt-4o' }).end();
    trace.end();

    expect(
      byName('upstream').attributes[LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS],
    ).toBeUndefined();
  });

  it('still exports a child span that outlives the trace', () => {
    const trace = telemetry.trace({ name: 'chat-turn' });
    const write = trace.span({ name: 'memory-write' });
    trace.end();
    write.end({ metadata: { written: 1 } });

    const root = byName('chat-turn');
    const memoryWrite = byName('memory-write');
    expect(memoryWrite.ended).toBe(true);
    expect(memoryWrite.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it('gives each trace its own trace id', () => {
    const first = telemetry.trace({ name: 'chat-turn' });
    first.end();
    const second = telemetry.trace({ name: 'mcp-tool' });
    second.end();

    expect(byName('chat-turn').spanContext().traceId).not.toBe(
      byName('mcp-tool').spanContext().traceId,
    );
  });

  it('flush resolves without error', async () => {
    telemetry.trace({ name: 'chat-turn' }).end();
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });
});
