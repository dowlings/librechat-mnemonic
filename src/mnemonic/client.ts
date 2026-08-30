import { performance } from 'node:perf_hooks';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import { activeSpan, type Span } from '../telemetry.js';

type QueueName = 'read' | 'write';

/** Where a call spent its time, in the order the phases happen. */
export type CallPhase = 'queue' | 'connect' | 'mnemonic';

export type CallOutcome = 'ok' | 'timeout' | 'tool_error' | 'unavailable' | 'error';

/** Per-tool counters, exposed on `/healthz` and in the periodic stats log. */
export interface ToolStats {
  calls: number;
  errors: number;
  timeouts: number;
  totalMs: number;
  maxMs: number;
  maxQueueWaitMs: number;
}

export interface MnemonicStats {
  connected: boolean;
  /** Connection attempts that succeeded. >1 means the connection was re-established. */
  connects: number;
  transportErrors: number;
  /** Milliseconds until the circuit breaker closes again; 0 when it is closed. */
  circuitOpenMs: number;
  /** Calls queued or running right now, per queue — the contention signal. */
  inFlight: Record<QueueName, number>;
  timeoutMs: number;
  slowCallMs: number;
  tools: Record<string, ToolStats>;
}

/** A single call's phase breakdown. Undefined phases were never reached. */
interface CallTiming {
  totalMs: number;
  queueWaitMs: number;
  connectMs?: number;
  callMs?: number;
}

/**
 * MCP's JSON-RPC code for a request that blew its deadline. The SDK raises it
 * as `McpError` both for the per-request timeout we set and for its own
 * maximum-total-timeout guard, so the code is the reliable signal — the message
 * differs between the two.
 */
const MCP_REQUEST_TIMEOUT = -32001;

/**
 * Did this call fail because it ran out of time, as opposed to mnemonic
 * rejecting it? Timeouts and tool errors need very different fixes, so they get
 * separated at the point where the distinction is still available.
 */
export function isMnemonicTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === MCP_REQUEST_TIMEOUT) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /timed out|timeout exceeded/i.test(message);
}

/** Millisecond delta, rounded — sub-millisecond precision is noise in a log line. */
function since(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * The phase that ate the most wall clock. This is the whole point of the
 * breakdown: a timeout blamed on `queue` is a concurrency problem in this
 * service, on `connect` a transport problem, on `mnemonic` a problem in
 * mnemonic itself (usually embedding or vector search).
 */
function slowestPhase(timing: CallTiming): CallPhase {
  const phases: Array<[CallPhase, number]> = [
    ['queue', timing.queueWaitMs],
    ['connect', timing.connectMs ?? 0],
    ['mnemonic', timing.callMs ?? 0],
  ];
  return phases.reduce((worst, phase) => (phase[1] > worst[1] ? phase : worst))[0];
}

function emptyToolStats(): ToolStats {
  return { calls: 0, errors: 0, timeouts: 0, totalMs: 0, maxMs: 0, maxQueueWaitMs: 0 };
}

/**
 * A failed call is one of four different problems. Naming which one in the log
 * line is the difference between "memory is broken again" and a diagnosis.
 */
function classifyOutcome(error: unknown): CallOutcome {
  if (isMnemonicTimeout(error)) return 'timeout';
  if (error instanceof MnemonicToolError) return 'tool_error';
  const message = error instanceof Error ? error.message : '';
  if (/circuit open|unavailable/i.test(message)) return 'unavailable';
  return 'error';
}

/**
 * A thin MCP client for mnemonic.
 *
 * Two things matter here beyond "call the tool":
 *
 * 1. Writes are serialised against each other. mnemonic commits to a git repo
 *    on every mutation, and concurrent writers race on `.git/index.lock`. One
 *    in-flight write at a time is cheap insurance. Reads get their own queue
 *    so a slow write from turn N does not block recall on turn N+1 — the
 *    original single-queue design made every recall pay for the previous
 *    turn's detached write.
 * 2. The connection is lazy and self-healing. A crashed stdio child or a
 *    dropped HTTP session reconnects on the next call rather than wedging the
 *    proxy.
 */
export class MnemonicClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private readQueue: Promise<unknown> = Promise.resolve();
  private writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * Same reasoning as the mongo breaker: a missing binary or an unreachable
   * remote must not make every turn pay a connection attempt.
   */
  private breakerOpenUntil = 0;
  private static readonly BREAKER_COOLDOWN_MS = 15_000;

  /** Tools that mutate the vault and must not run concurrently. */
  private static readonly WRITE_TOOLS = new Set(['remember', 'forget', 'update']);

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Everything below exists to answer one question from the logs alone: when a
  // call times out, was it waiting behind other calls, waiting on a connection,
  // or waiting on mnemonic?

  /** Calls queued or running, per queue. Read at enqueue time as the depth ahead. */
  private readonly inFlight: Record<QueueName, number> = { read: 0, write: 0 };
  private callSeq = 0;
  private connects = 0;
  private transportErrors = 0;
  private readonly toolStats = new Map<string, ToolStats>();

  /**
   * The last few lines mnemonic wrote to stderr. They are logged at `debug`
   * as they arrive, which is useless at the `info` level people actually run
   * in production — so they are also kept here and attached to the log line
   * for a call that times out, where they are usually the explanation.
   */
  private readonly recentStderr: string[] = [];
  private static readonly STDERR_BUFFER = 20;

  constructor(private readonly config: AppConfig) {}

  private noteStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.recentStderr.push(trimmed.slice(0, 500));
    }
    while (this.recentStderr.length > MnemonicClient.STDERR_BUFFER) this.recentStderr.shift();
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;

    if (Date.now() < this.breakerOpenUntil) {
      throw new Error('mnemonic is unavailable (circuit open)');
    }

    if (this.connecting) return this.connecting;

    const startedAt = performance.now();
    this.connecting = (async () => {
      const client = new Client(
        { name: 'librechat-mnemonic', version: '0.1.0' },
        { capabilities: {} },
      );

      if (this.config.mnemonic.mode === 'remote') {
        const url = new URL(this.config.mnemonic.url!);
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: this.config.mnemonic.headers },
        });
        await client.connect(transport);
        logger.info(
          { url: url.origin, durationMs: since(startedAt), attempt: this.connects + 1 },
          'connected to remote mnemonic',
        );
      } else {
        const transport = new StdioClientTransport({
          command: this.config.mnemonic.command,
          args: this.config.mnemonic.args,
          env: {
            ...(process.env as Record<string, string>),
            VAULT_PATH: this.config.mnemonic.vaultPath,
          },
          stderr: 'pipe',
        });
        /*
         * Without this the transport rethrows child-process errors as an
         * uncaught exception and takes the whole proxy down. A missing binary
         * must degrade to "no memory", not to "no chat".
         */
        transport.onerror = (error) => {
          this.transportErrors += 1;
          logger.error(
            {
              err: error,
              transportErrors: this.transportErrors,
              inFlight: { ...this.inFlight },
              recentStderr: this.recentStderr.slice(-5),
            },
            'mnemonic transport error',
          );
          this.client = null;
          this.breakerOpenUntil = Date.now() + MnemonicClient.BREAKER_COOLDOWN_MS;
        };
        await client.connect(transport);
        transport.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString().trimEnd();
          this.noteStderr(text);
          logger.debug({ mnemonic: text }, 'mnemonic stderr');
        });
        logger.info(
          {
            command: this.config.mnemonic.command,
            vault: this.config.mnemonic.vaultPath,
            durationMs: since(startedAt),
            attempt: this.connects + 1,
          },
          'spawned mnemonic',
        );
      }

      client.onclose = () => {
        logger.warn(
          { inFlight: { ...this.inFlight }, recentStderr: this.recentStderr.slice(-5) },
          'mnemonic connection closed; will reconnect on next call',
        );
        this.client = null;
      };

      this.client = client;
      this.connects += 1;
      this.breakerOpenUntil = 0;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      this.client = null;
      this.breakerOpenUntil = Date.now() + MnemonicClient.BREAKER_COOLDOWN_MS;
      logger.error(
        {
          err: error,
          mode: this.config.mnemonic.mode,
          durationMs: since(startedAt),
          cooldownMs: MnemonicClient.BREAKER_COOLDOWN_MS,
          recentStderr: this.recentStderr.slice(-5),
        },
        'mnemonic connection failed; pausing memory operations',
      );
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Run `fn` after every previously queued call on the same queue has settled.
   * Reads and writes have separate queues so they never block each other.
   */
  private serialise<T>(fn: () => Promise<T>, isWrite: boolean): Promise<T> {
    const queue = isWrite ? this.writeQueue : this.readQueue;
    const run = queue.then(fn, fn);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    if (isWrite) {
      this.writeQueue = next;
    } else {
      this.readQueue = next;
    }
    return run;
  }

  /**
   * Call a mnemonic tool.
   *
   * Both halves of the result are returned. mnemonic puts machine-readable
   * metadata in `structuredContent` and human-readable rendering (including
   * note bodies, for `recall`) in the text content, and different callers here
   * want different halves.
   */
  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<MnemonicResult<T>> {
    const isWrite = MnemonicClient.WRITE_TOOLS.has(tool);
    const queue: QueueName = isWrite ? 'write' : 'read';
    const timeoutMs = this.config.mnemonic.timeoutMs;
    const slowCallMs = this.config.mnemonic.slowCallMs;

    const parent = activeSpan();
    const attributes = {
      'mnemonic.tool': tool,
      'mnemonic.timeout_ms': timeoutMs,
    };

    // Opened before joining the queue and closed when the work actually starts,
    // so its duration *is* the time spent waiting behind other calls — the
    // number that distinguishes a slow mnemonic from a contended one.
    const queueSpan = parent.span({
      name: 'queue_wait',
      metadata: { ...attributes, 'mnemonic.queue': queue },
    });
    let queueSpanOpen = true;
    const endQueueSpan = () => {
      if (queueSpanOpen) {
        queueSpanOpen = false;
        queueSpan.end();
      }
    };

    const callId = ++this.callSeq;
    // Read before the increment: this is how many calls are ahead of this one.
    const queueDepth = this.inFlight[queue];
    this.inFlight[queue] += 1;

    const enqueuedAt = performance.now();
    let startedAt: number | undefined;
    let connectedAt: number | undefined;

    const identity = { callId, tool, queue, queueDepth, timeoutMs };
    logger.debug(identity, 'mnemonic call queued');

    const timing = (): CallTiming => {
      const totalMs = since(enqueuedAt);
      if (startedAt === undefined) return { totalMs, queueWaitMs: totalMs };
      const queueWaitMs = Math.round(startedAt - enqueuedAt);
      if (connectedAt === undefined) {
        return { totalMs, queueWaitMs, connectMs: totalMs - queueWaitMs };
      }
      return {
        totalMs,
        queueWaitMs,
        connectMs: Math.round(connectedAt - startedAt),
        callMs: Math.round(performance.now() - connectedAt),
      };
    };

    /*
     * A wedged mnemonic produces no log line at all until its timeout finally
     * trips — by which point the chat turn is already ruined and the operator
     * is looking at a gap. This fires while the call is still running and says
     * which phase it is stuck in.
     */
    const watchdog = setTimeout(() => {
      const current = timing();
      logger.warn(
        { ...identity, ...current, phase: slowestPhase(current), inFlight: { ...this.inFlight } },
        'mnemonic call still in flight',
      );
    }, slowCallMs);
    watchdog.unref?.();

    try {
      const result = await this.serialise(async () => {
        startedAt = performance.now();
        endQueueSpan();
        const client = await this.connectTraced(parent, attributes);
        connectedAt = performance.now();
        const response = await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: timeoutMs,
        });

        const text = extractText(response as { content?: unknown });
        if (response.isError) {
          throw new MnemonicToolError(tool, text || 'unknown mnemonic error');
        }

        return { structured: response.structuredContent as T | undefined, text };
      }, isWrite);

      this.report(identity, timing(), 'ok');
      return result;
    } catch (error) {
      this.report(identity, timing(), classifyOutcome(error), error);
      throw error;
    } finally {
      clearTimeout(watchdog);
      this.inFlight[queue] -= 1;
      // The queue span is normally closed when the work starts; this covers the
      // case where the call never got that far.
      endQueueSpan();
    }
  }

  /**
   * One log line per completed call, at a level that matches how bad it was,
   * plus the counters behind `/healthz`. Kept in one place so every exit path
   * from `call()` produces the same fields.
   */
  private report(
    identity: {
      callId: number;
      tool: string;
      queue: QueueName;
      queueDepth: number;
      timeoutMs: number;
    },
    timing: CallTiming,
    outcome: CallOutcome,
    error?: unknown,
  ): void {
    const stats = this.toolStats.get(identity.tool) ?? emptyToolStats();
    stats.calls += 1;
    stats.totalMs += timing.totalMs;
    stats.maxMs = Math.max(stats.maxMs, timing.totalMs);
    stats.maxQueueWaitMs = Math.max(stats.maxQueueWaitMs, timing.queueWaitMs);
    if (outcome !== 'ok') stats.errors += 1;
    if (outcome === 'timeout') stats.timeouts += 1;
    this.toolStats.set(identity.tool, stats);

    // This call is still counted in `inFlight` until `call()`'s finally block
    // runs; report what else was going on, not including itself.
    const inFlight = { ...this.inFlight };
    inFlight[identity.queue] -= 1;

    const detail = { ...identity, ...timing, outcome, phase: slowestPhase(timing), inFlight };

    if (outcome === 'timeout') {
      logger.error(
        { ...detail, err: error, recentStderr: this.recentStderr.slice(-10) },
        'mnemonic call timed out',
      );
      return;
    }
    if (outcome !== 'ok') {
      logger.warn({ ...detail, err: error }, 'mnemonic call failed');
      return;
    }
    if (timing.totalMs >= this.config.mnemonic.slowCallMs) {
      logger.warn(detail, 'slow mnemonic call');
      return;
    }
    logger.debug(detail, 'mnemonic call complete');
  }

  /** Snapshot for `/healthz` and the periodic stats log. */
  get stats(): MnemonicStats {
    const openFor = this.breakerOpenUntil - Date.now();
    return {
      connected: this.client !== null,
      connects: this.connects,
      transportErrors: this.transportErrors,
      circuitOpenMs: openFor > 0 ? openFor : 0,
      inFlight: { ...this.inFlight },
      timeoutMs: this.config.mnemonic.timeoutMs,
      slowCallMs: this.config.mnemonic.slowCallMs,
      tools: Object.fromEntries([...this.toolStats].map(([tool, stat]) => [tool, { ...stat }])),
    };
  }

  /**
   * `connect()` with a span around it. Always emitted — a near-zero span with
   * `cached: true` is what tells you the connection was reused rather than
   * leaving a hole in the waterfall.
   */
  private async connectTraced(parent: Span, attributes: Record<string, unknown>): Promise<Client> {
    const span = parent.span({
      name: 'connect',
      metadata: { ...attributes, 'mnemonic.mode': this.config.mnemonic.mode },
    });
    const cached = this.client !== null;
    try {
      const client = await this.connect();
      span.end({ metadata: { 'mnemonic.connection_cached': cached } });
      return client;
    } catch (error) {
      span.recordException(error);
      span.end({ metadata: { 'mnemonic.connection_cached': cached, status: 'error' } });
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await client.close().catch(() => undefined);
    }
  }
}

export interface MnemonicResult<T> {
  structured: T | undefined;
  text: string;
}

export class MnemonicToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`mnemonic ${tool} failed: ${message}`);
    this.name = 'MnemonicToolError';
  }
}

function extractText(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => {
      return (
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      );
    })
    .map((part) => part.text)
    .join('\n')
    .trim();
}
