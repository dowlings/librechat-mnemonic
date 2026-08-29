import { LangfuseOtelSpanAttributes } from '@langfuse/core';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { type LangfuseSpan, setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import type { Attributes } from '@opentelemetry/api';
import { BasicTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { logger } from './logger.js';

export interface TraceOptions {
  name: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface SpanOptions {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface Span {
  end(metadata?: Record<string, unknown>): void;
}

/**
 * Token counts for a single model call, in the SDK's OpenAI-shaped usage
 * format. Canonical definition; re-exported from `proxy/adapters.ts` so both
 * the wire-format adapters and the Langfuse layer share one shape.
 */
export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface GenerationOptions {
  name: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationEndOptions {
  usage?: UsageInfo;
  metadata?: Record<string, unknown>;
}

export interface Generation {
  end(options?: GenerationEndOptions): void;
}

export interface Trace {
  span(options: SpanOptions): Span;
  generation(options: GenerationOptions): Generation;
  end(): void;
}

export interface Telemetry {
  readonly enabled: boolean;
  trace(options: TraceOptions): Trace;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Attribute values must be primitives; anything else is JSON for the UI. */
function serializeAttribute(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Trace-level fields live as OTel attributes on the root span — v5 has no
 * separate "create a trace" call, so user/session/metadata have to be written
 * with the wire keys the Langfuse span processor reads.
 */
function traceAttributes(options: TraceOptions): Attributes {
  const attributes: Attributes = {
    [LangfuseOtelSpanAttributes.TRACE_NAME]: options.name,
  };
  if (options.sessionId) {
    attributes[LangfuseOtelSpanAttributes.TRACE_SESSION_ID] = options.sessionId;
  }
  if (options.userId) {
    attributes[LangfuseOtelSpanAttributes.TRACE_USER_ID] = options.userId;
  }
  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    const serialized = serializeAttribute(value);
    if (serialized !== undefined) {
      attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`] = serialized;
    }
  }
  return attributes;
}

/** Langfuse's generic usage keys, mapped from our OpenAI-shaped counts. */
function toUsageDetails(usage?: UsageInfo): Record<string, number> | undefined {
  if (!usage) return undefined;
  const details: Record<string, number> = {};
  if (typeof usage.promptTokens === 'number') details.input = usage.promptTokens;
  if (typeof usage.completionTokens === 'number') details.output = usage.completionTokens;
  if (typeof usage.totalTokens === 'number') details.total = usage.totalTokens;
  return Object.keys(details).length > 0 ? details : undefined;
}

function wrapTrace(root: LangfuseSpan): Trace {
  return {
    span: (spanOptions: SpanOptions): Span => {
      const span = root.startObservation(spanOptions.name, { metadata: spanOptions.metadata });
      return {
        end: (metadata?: Record<string, unknown>) => {
          if (metadata) span.update({ metadata });
          span.end();
        },
      };
    },
    generation: (genOptions: GenerationOptions): Generation => {
      const generation = root.startObservation(
        genOptions.name,
        { model: genOptions.model, metadata: genOptions.metadata },
        { asType: 'generation' },
      );
      return {
        end: (endOptions?: GenerationEndOptions) => {
          generation.update({
            metadata: endOptions?.metadata,
            usageDetails: toUsageDetails(endOptions?.usage),
          });
          generation.end();
        },
      };
    },
    // A v5 trace *is* its root span, so ending it stamps the trace end time.
    // Children that outlive it (the detached memory write) still export on
    // their own end — OTel exports each span independently.
    end: () => root.end(),
  };
}

/**
 * Real telemetry backed by the Langfuse v5 (OpenTelemetry) SDK.
 *
 * The span processor batches exports asynchronously and swallows network
 * failures, so creating traces and spans is always safe even if Langfuse is
 * unreachable.
 */
export class LangfuseTelemetry implements Telemetry {
  readonly enabled = true;
  private readonly provider: BasicTracerProvider;

  constructor(processor: SpanProcessor) {
    this.provider = new BasicTracerProvider({ spanProcessors: [processor] });
    // Isolated rather than global: this provider only ever serves Langfuse's
    // own tracer, so we never take over OTel for the rest of the process. It
    // also means no global context manager, which keeps every `trace()` a real
    // root span instead of a child of whatever else happens to be active.
    setLangfuseTracerProvider(this.provider);
  }

  trace(options: TraceOptions): Trace {
    const root = startObservation(options.name, { metadata: options.metadata });
    root.otelSpan.setAttributes(traceAttributes(options));
    return wrapTrace(root);
  }

  async flush(): Promise<void> {
    await this.provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }
}

/**
 * Null-object telemetry. Used when no Langfuse credentials are configured so
 * the proxy never has to branch on "is telemetry on?".
 */
class NoopTelemetry implements Telemetry {
  readonly enabled = false;

  trace(): Trace {
    const noopSpan: Span = { end: () => {} };
    const noopGeneration: Generation = { end: () => {} };
    return {
      span: () => noopSpan,
      generation: () => noopGeneration,
      end: () => {},
    };
  }

  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export function createTelemetry(config: {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl: string;
}): Telemetry {
  if (config.enabled && config.publicKey && config.secretKey) {
    logger.info({ baseUrl: config.baseUrl }, 'langfuse telemetry enabled');
    return new LangfuseTelemetry(
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
      }),
    );
  }
  return new NoopTelemetry();
}
