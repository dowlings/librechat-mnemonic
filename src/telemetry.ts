import { Langfuse } from 'langfuse';

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

export interface Trace {
  span(options: SpanOptions): Span;
  end(): void;
}

export interface Telemetry {
  readonly enabled: boolean;
  trace(options: TraceOptions): Trace;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Real telemetry backed by the Langfuse SDK.
 *
 * The SDK batches events asynchronously and is resilient to network failures:
 * a dropped batch is logged, not thrown. Creating traces and spans is
 * therefore always safe, even if Langfuse is unreachable.
 */
class LangfuseTelemetry implements Telemetry {
  readonly enabled = true;
  private readonly client: Langfuse;

  constructor(publicKey: string, secretKey: string, baseUrl: string) {
    this.client = new Langfuse({ publicKey, secretKey, baseUrl });
  }

  trace(options: TraceOptions): Trace {
    const trace = this.client.trace({
      name: options.name,
      sessionId: options.sessionId,
      userId: options.userId,
      metadata: options.metadata,
    });
    return {
      span: (spanOptions: SpanOptions): Span => {
        const span = trace.span({
          name: spanOptions.name,
          metadata: spanOptions.metadata,
        });
        return {
          end: (metadata?: Record<string, unknown>) => {
            if (metadata) span.update({ metadata });
            span.end();
          },
        };
      },
      // Langfuse traces have no explicit end call — only spans/generations do.
      // A trace is implicitly complete once its observations stop arriving.
      end: () => {},
    };
  }

  async flush(): Promise<void> {
    await this.client.flushAsync();
  }

  async shutdown(): Promise<void> {
    await this.client.flushAsync();
  }
}

/**
 * Null-object telemetry. Used when no Langfuse credentials are configured so
 * the proxy never has to branch on "is telemetry on?".
 */
class NoopTelemetry implements Telemetry {
  readonly enabled = false;

  trace(_options: TraceOptions): Trace {
    const noopSpan: Span = { end: () => {} };
    return {
      span: () => noopSpan,
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
    return new LangfuseTelemetry(config.publicKey, config.secretKey, config.baseUrl);
  }
  return new NoopTelemetry();
}