import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';

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

  constructor(private readonly config: AppConfig) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;

    if (Date.now() < this.breakerOpenUntil) {
      throw new Error('mnemonic is unavailable (circuit open)');
    }

    if (this.connecting) return this.connecting;

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
        logger.info({ url: url.origin }, 'connected to remote mnemonic');
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
          logger.error({ err: error }, 'mnemonic transport error');
          this.client = null;
          this.breakerOpenUntil = Date.now() + MnemonicClient.BREAKER_COOLDOWN_MS;
        };
        await client.connect(transport);
        transport.stderr?.on('data', (chunk: Buffer) => {
          logger.debug({ mnemonic: chunk.toString().trimEnd() }, 'mnemonic stderr');
        });
        logger.info(
          { command: this.config.mnemonic.command, vault: this.config.mnemonic.vaultPath },
          'spawned mnemonic',
        );
      }

      client.onclose = () => {
        logger.warn('mnemonic connection closed; will reconnect on next call');
        this.client = null;
      };

      this.client = client;
      this.breakerOpenUntil = 0;
      return client;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      this.client = null;
      this.breakerOpenUntil = Date.now() + MnemonicClient.BREAKER_COOLDOWN_MS;
      logger.error(
        { err: error, mode: this.config.mnemonic.mode },
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
    return this.serialise(async () => {
      const client = await this.connect();
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.config.mnemonic.timeoutMs,
      });

      const text = extractText(result as { content?: unknown });
      if (result.isError) {
        throw new MnemonicToolError(tool, text || 'unknown mnemonic error');
      }

      return { structured: result.structuredContent as T | undefined, text };
    }, isWrite);
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
