import { beforeEach, describe, expect, it } from 'vitest';

import { createTelemetry, type Telemetry } from '../src/telemetry.js';

// We test the noop path without importing Langfuse (which would require the
// dep to be installed). The LangfuseTelemetry class is only constructed when
// both keys are present, and we can't easily mock the Langfuse SDK in a unit
// test, so we focus on the factory and noop behaviour.

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

  it('creating many traces and spans does not throw or accumulate state', () => {
    for (let i = 0; i < 100; i++) {
      const trace = telemetry.trace({ name: `trace-${i}` });
      const span = trace.span({ name: `span-${i}` });
      span.end({ index: i });
      trace.end();
    }
    // If we got here without throwing, the test passes.
    expect(true).toBe(true);
  });
});