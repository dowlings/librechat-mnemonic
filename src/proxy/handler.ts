import type { Request, Response } from 'express';

import type { AppConfig, UpstreamConfig } from '../config.js';
import type { LibreChatStore } from '../librechat/mongo.js';
import { logger } from './logger.js';
import { extractExplicit, extractWithModel, type ModelSpec } from '../memory/extract.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryContext } from '../memory/types.js';
import type { Telemetry, Trace } from '../telemetry.js';
import { adapterFor, collectStreamText, type ChatAdapter } from './adapters.js';
import { parseCommand, runCommand } from './commands.js';
import { buildMemoryBlock, buildRecallQuery, messageText } from './inject.js';

/** Headers that must not be relayed. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  // `fetch` (undici) transparently decompresses gzip/br response bodies when
  // reading `.body`/`.text()`, but does not strip the original
  // `Content-Encoding` header from `upstreamResponse.headers`. Relaying it
  // unchanged tells the downstream client (LibreChat) the body is still
  // compressed, so it attempts to decompress already-decompressed bytes and
  // fails with a zlib "incorrect header check" error. Observed against
  // Gemini's `/v1beta/openai/models` endpoint, which gzips its response;
  // Ollama's equivalent endpoint doesn't compress, which is why only Gemini
  // triggered this.
  'content-encoding',
]);

export interface ProxyDeps {
  config: AppConfig;
  store: LibreChatStore;
  memory: MemoryService;
  telemetry: Telemetry;
}

export function createProxyHandler(deps: ProxyDeps) {
  const { config, store, memory, telemetry } = deps;
  const byName = new Map(config.upstreams.map((upstream) => [upstream.name, upstream]));

  return async function handle(req: Request, res: Response): Promise<void> {
    const rawName = (req.params as Record<string, string | string[] | undefined>).upstream;
    const name = Array.isArray(rawName) ? rawName[0] : rawName;
    const upstream = name ? byName.get(name) : undefined;
    if (!upstream) {
      res.status(404).json({ error: { message: `Unknown upstream "${name ?? ''}"` } });
      return;
    }

    const rest = req.url === '/' ? '' : req.url;
    const targetUrl = `${upstream.baseUrl.replace(/\/+$/, '')}${rest}`;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    const pathname = rest.split('?')[0] ?? '';
    const isChat =
      req.method === 'POST' &&
      (/\/chat\/completions$/.test(pathname) || /\/messages$/.test(pathname));

    if (!isChat) {
      await passthrough(req, res, targetUrl, body, upstream);
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      await passthrough(req, res, targetUrl, body, upstream);
      return;
    }

    const format = /\/messages$/.test(pathname) ? 'anthropic' : 'openai';
    const adapter = adapterFor(format);

    const userId = headerValue(req, config.librechat.userHeader);
    const conversationId = headerValue(req, config.librechat.conversationHeader);

    /*
     * No conversation id means this is not a user-facing chat turn: LibreChat
     * leaves {{LIBRECHAT_BODY_*}} unresolved for side calls such as title
     * generation and its own memory agent. Those must not be augmented, and
     * must not produce memories.
     */
    if (!conversationId) {
      await passthrough(req, res, targetUrl, body, upstream);
      return;
    }

    const messages = adapter.conversation(parsed);
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const lastUserText = messageText(lastUser?.content).trim();

    // Commands work even when memory is off, otherwise `/memory on` is unreachable.
    const command = parseCommand(lastUserText, config.memory.commandPrefix);
    if (command) {
      const context = await memory.resolveContext(userId, conversationId);
      const result = await runCommand(command, context, { config, store, memory });
      sendSynthetic(res, result.reply, parsed, format);
      return;
    }

    const setting = await store.getMemorySetting(userId, conversationId);
    if (!setting.enabled) {
      await passthrough(req, res, targetUrl, body, upstream);
      return;
    }

    // ── Telemetry: one trace per augmented chat turn ────────────────────────
    const trace = telemetry.trace({
      name: 'chat-turn',
      sessionId: conversationId,
      userId: userId ?? undefined,
      metadata: {
        upstream: upstream.name,
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
        format,
      },
    });

    // One retry: on the first turn of a brand new chat the conversation
    // document may not be written yet.
    const ctxSpan = trace.span({ name: 'resolve-context' });
    const context = await memory.resolveContext(userId, conversationId, { retries: 1 });
    ctxSpan.end({ project: context.projectName });

    let outgoing = parsed;
    if (config.memory.recallEnabled) {
      const recallSpan = trace.span({ name: 'recall' });
      const query = buildRecallQuery(messages, {
        messageCount: config.memory.queryMessageCount,
        maxChars: config.memory.queryMaxChars,
      });
      if (query) {
        const recalled = await memory.recall(context, query);
        const block = buildMemoryBlock(recalled, context, config.memory.maxContextChars);
        recallSpan.end({
          count: recalled.length,
          hasBlock: !!block,
          cacheStats: memory.cacheStats.recall,
        });
        if (block) {
          outgoing = adapter.inject(parsed, block);
          logger.debug(
            { conversationId, project: context.projectName, count: recalled.length },
            'injected recalled memories',
          );
        }
      } else {
        recallSpan.end({ count: 0 });
      }
    }

    // Ensure Ollama (and other OpenAI-compatible upstreams) return token usage
    // in the final SSE chunk of streaming responses. Without this flag the
    // upstream omits usage entirely, so LibreChat's Langfuse integration
    // records empty usageDetails on every GENERATION observation. Only
    // applies to OpenAI-format streaming requests; Anthropic's Messages API
    // always includes usage in message_delta.
    if (format === 'openai' && outgoing.stream === true) {
      const existing = outgoing.stream_options as Record<string, unknown> | undefined;
      outgoing = {
        ...outgoing,
        stream_options: { ...(existing ?? {}), include_usage: true },
      };
    }

    const outgoingBody = Buffer.from(JSON.stringify(outgoing), 'utf8');

    const onAssistantText = (text: string) => {
      if (config.memory.writeMode === 'off') return;
      void writeMemories({
        config,
        memory,
        context,
        adapter,
        upstream,
        req,
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
        userText: lastUserText,
        assistantText: text,
        trace,
      });
    };

    const upstreamSpan = trace.span({ name: 'upstream' });
    await passthrough(req, res, targetUrl, outgoingBody, upstream, { adapter, onAssistantText });
    upstreamSpan.end();

    // End the trace now that the response is sent. The write span may still be
    // in flight (writeMemories is detached); Langfuse handles late span ends.
    trace.end();
  };
}

interface TapOptions {
  adapter: ChatAdapter;
  onAssistantText: (text: string) => void;
}

async function passthrough(
  req: Request,
  res: Response,
  targetUrl: string,
  body: Buffer,
  upstream: UpstreamConfig,
  tap?: TapOptions,
): Promise<void> {
  const headers = buildUpstreamHeaders(req, upstream, body);

  let upstreamResponse: globalThis.Response;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
  } catch (error) {
    logger.error({ err: error, targetUrl }, 'upstream request failed');
    if (!res.headersSent) {
      res.status(502).json({ error: { message: 'Upstream request failed', type: 'proxy_error' } });
    }
    return;
  }

  res.status(upstreamResponse.status);
  upstreamResponse.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
  });

  if (!upstreamResponse.body) {
    const text = await upstreamResponse.text();
    if (tap && upstreamResponse.ok) captureNonStream(text, tap);
    res.end(text);
    return;
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  const isStream = contentType.includes('text/event-stream');
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = upstreamResponse.body.getReader();

  // If the client disconnects mid-stream, stop pulling from upstream.
  let aborted = false;
  res.on('close', () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted) break;
      res.write(Buffer.from(value));
      if (tap && upstreamResponse.ok) chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    logger.error({ err: error }, 'error relaying upstream stream');
  } finally {
    res.end();
  }

  if (!tap || !upstreamResponse.ok || aborted) return;

  const raw = chunks.join('');
  const text = isStream ? collectStreamText(raw, tap.adapter) : safeNonStreamText(raw, tap.adapter);
  if (text.trim()) tap.onAssistantText(text);
}

function captureNonStream(text: string, tap: TapOptions): void {
  const extracted = safeNonStreamText(text, tap.adapter);
  if (extracted.trim()) tap.onAssistantText(extracted);
}

function safeNonStreamText(raw: string, adapter: ChatAdapter): string {
  try {
    return adapter.responseText(JSON.parse(raw));
  } catch {
    return '';
  }
}

function buildUpstreamHeaders(
  req: Request,
  upstream: UpstreamConfig,
  body: Buffer,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  if (upstream.apiKey) {
    if (upstream.api === 'anthropic') headers['x-api-key'] = upstream.apiKey;
    else headers.authorization = `Bearer ${upstream.apiKey}`;
  }

  if (body.length > 0) headers['content-length'] = String(body.length);
  return headers;
}

function headerValue(req: Request, name: string): string | null {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed ? trimmed : null;
}

/**
 * Answer a `/memory ...` command without calling the model, in whichever shape
 * the caller asked for.
 */
function sendSynthetic(
  res: Response,
  reply: string,
  requestBody: Record<string, unknown>,
  format: 'openai' | 'anthropic',
): void {
  const stream = requestBody.stream === true;
  const model = typeof requestBody.model === 'string' ? requestBody.model : 'librechat-mnemonic';
  const id = `mnemonic-${Date.now().toString(36)}`;

  if (!stream) {
    res.setHeader('content-type', 'application/json');
    if (format === 'anthropic') {
      res.json({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } else {
      res.json({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    return;
  }

  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const send = (event: unknown, eventName?: string) => {
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (format === 'anthropic') {
    send(
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      'message_start',
    );
    send(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    );
    send(
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
      'content_block_delta',
    );
    send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
    send(
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      'message_delta',
    );
    send({ type: 'message_stop' }, 'message_stop');
    res.end();
    return;
  }

  const created = Math.floor(Date.now() / 1000);
  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
  });
  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

interface WriteArgs {
  config: AppConfig;
  memory: MemoryService;
  context: MemoryContext;
  adapter: ChatAdapter;
  upstream: UpstreamConfig;
  req: Request;
  model?: string;
  userText: string;
  assistantText: string;
  trace: Trace;
}

/**
 * Post-turn write. Runs detached: the user's response has already been
 * delivered, so nothing here can slow down or break the chat.
 */
async function writeMemories(args: WriteArgs): Promise<void> {
  const { config, memory, context, userText, assistantText, trace } = args;
  const writeSpan = trace.span({ name: 'memory-write' });
  let outcome: Record<string, unknown> = { candidates: 0 };
  try {
    let candidates =
      config.memory.writeMode === 'explicit'
        ? extractExplicit(userText)
        : await extractWithModel(
            extractionSpec(args),
            { user: userText, assistant: assistantText, project: context.projectName },
            config,
          );

    if (candidates.length === 0) return;
    candidates = candidates.slice(0, config.memory.maxPerTurn);

    // Stamp auto-extracted notes with role: context and an auto-extracted tag
    // so they can be distinguished from explicit saves and prioritized differently.
    for (const candidate of candidates) {
      candidate.role = candidate.role ?? 'context';
      candidate.tags = [...(candidate.tags ?? []), 'auto-extracted'];
    }

    // The context was resolved before the turn; re-resolve so a chat created
    // inside a project on this very turn still lands in the right place.
    const fresh = await memory.resolveContext(context.userId, context.conversationId);
    for (const candidate of candidates) {
      await memory.save(fresh, candidate);
    }
    outcome = { candidates: candidates.length, cacheStats: memory.cacheStats.noteBody };
  } catch (error) {
    outcome = { error: 'write-failed' };
    logger.error({ err: error }, 'post-turn memory write failed');
  } finally {
    // Always end the span exactly once, even if the catch block itself throws.
    writeSpan.end(outcome);
  }
}

/** Prefer a dedicated extraction model; otherwise reuse the chat's own upstream. */
function extractionSpec(args: WriteArgs): ModelSpec {
  const { config, upstream, req, model } = args;

  if (config.extract.baseUrl && config.extract.model) {
    return {
      api: 'openai',
      baseUrl: config.extract.baseUrl,
      model: config.extract.model,
      headers: config.extract.apiKey
        ? { authorization: `Bearer ${config.extract.apiKey}` }
        : {},
    };
  }

  const headers: Record<string, string> = {};
  const auth = req.headers.authorization;
  if (typeof auth === 'string') headers.authorization = auth;
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') headers['x-api-key'] = apiKeyHeader;
  if (upstream.apiKey) {
    if (upstream.api === 'anthropic') headers['x-api-key'] = upstream.apiKey;
    else headers.authorization = `Bearer ${upstream.apiKey}`;
  }

  return {
    api: upstream.api,
    baseUrl:
      upstream.api === 'anthropic'
        ? upstream.baseUrl
        : `${upstream.baseUrl.replace(/\/+$/, '')}/v1`,
    model: config.extract.model ?? model ?? 'gpt-4o-mini',
    headers,
  };
}