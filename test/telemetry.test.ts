import { LangfuseOtelSpanAttributes } from '@langfuse/core';
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
    expect(() => span.end({ foo: 'bar' })).not.toThrow();
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
      const span = trace.span({ name: `span-${i}` });
      span.end({ index: i });
      const generation = trace.generation({ name: `gen-${i}`, model: 'gpt-4o' });
      generation.end({ usage: { promptTokens: i, completionTokens: i, totalTokens: i * 2 } });
      trace.end();
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
    expect(
      attributes[`${LangfuseOtelSpanAttributes.OBSERVATION_METADATA}.memory`],
    ).toBeUndefined();
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
    span.end({ hits: 2 });
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
    write.end({ written: 1 });

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
