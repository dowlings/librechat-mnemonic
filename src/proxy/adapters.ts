import type { UsageInfo } from '../telemetry.js';
import { injectSystemMessage, messageText, type SimpleMessage } from './inject.js';

export type { UsageInfo } from '../telemetry.js';

/**
 * The two wire formats LibreChat can point at a custom endpoint.
 *
 * `provider: anthropic` custom endpoints use the native Messages API, which
 * carries the system prompt in a top-level `system` field rather than as a
 * message. Everything else in LibreChat speaks OpenAI-compatible.
 */
export type WireFormat = 'openai' | 'anthropic';

export interface ChatAdapter {
  /** Messages used to build the recall query. */
  conversation(body: Record<string, unknown>): SimpleMessage[];
  /**
   * Return a new body with `block` added to the system prompt. `marker` is the
   * block's sentinel, used to skip a request that already carries one.
   */
  inject(body: Record<string, unknown>, block: string, marker: string): Record<string, unknown>;
  /** Pull the assistant's text out of a non-streaming response. */
  responseText(json: unknown): string;
  /** Pull assistant text out of one parsed SSE data payload. */
  streamDelta(event: unknown): string;
  /** Pull token usage out of a non-streaming response, if present. */
  responseUsage(json: unknown): UsageInfo | undefined;
  /** Fold usage carried by one parsed SSE data payload into `acc`, mutating and returning it. */
  accumulateStreamUsage(event: unknown, acc: UsageInfo): UsageInfo;
}

export const openaiAdapter: ChatAdapter = {
  conversation(body) {
    const messages = Array.isArray(body.messages) ? (body.messages as SimpleMessage[]) : [];
    return messages;
  },

  inject(body, block, marker) {
    const messages = Array.isArray(body.messages) ? (body.messages as SimpleMessage[]) : [];
    const next = injectSystemMessage(
      messages,
      block,
      (content) => ({ role: 'system', content }),
      marker,
    );
    return { ...body, messages: next };
  },

  responseText(json) {
    const choices = (json as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    return messageText(choices?.[0]?.message?.content);
  },

  streamDelta(event) {
    const choices = (event as { choices?: Array<{ delta?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  },

  responseUsage(json) {
    const usage = (
      json as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      }
    ).usage;
    return usage ? openaiUsage(usage) : undefined;
  },

  // The terminal chunk of an OpenAI-compatible stream (requested via
  // `stream_options: { include_usage: true }`) carries `usage` alongside an
  // empty `choices` array, so this only ever fires once per stream.
  accumulateStreamUsage(event, acc) {
    const usage = (
      event as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      }
    ).usage;
    return usage ? Object.assign(acc, openaiUsage(usage)) : acc;
  },
};

function openaiUsage(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): UsageInfo {
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

export const anthropicAdapter: ChatAdapter = {
  conversation(body) {
    const messages = Array.isArray(body.messages) ? (body.messages as SimpleMessage[]) : [];
    return messages;
  },

  inject(body, block, marker) {
    const system = body.system;

    if (typeof system === 'string') {
      if (system.includes(marker)) return body;
      return { ...body, system: `${system}\n\n${block}` };
    }

    if (Array.isArray(system)) {
      if (messageText(system).includes(marker)) return body;
      return { ...body, system: [...system, { type: 'text', text: block }] };
    }

    return { ...body, system: block };
  },

  responseText(json) {
    const content = (json as { content?: Array<{ type?: string; text?: string }> }).content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
  },

  streamDelta(event) {
    const typed = event as { type?: string; delta?: { type?: string; text?: unknown } };
    if (typed.type === 'content_block_delta' && typeof typed.delta?.text === 'string') {
      return typed.delta.text;
    }
    return '';
  },

  responseUsage(json) {
    const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (!usage) return undefined;
    return anthropicUsage(usage.input_tokens, usage.output_tokens);
  },

  // Anthropic splits usage across two events: `message_start` carries the
  // (already-known) input tokens, `message_delta` carries the output tokens
  // once generation finishes. Both may arrive, so accumulate rather than
  // overwrite.
  accumulateStreamUsage(event, acc) {
    const typed = event as {
      type?: string;
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (typed.type === 'message_start' && typed.message?.usage) {
      Object.assign(acc, anthropicUsage(typed.message.usage.input_tokens, acc.completionTokens));
    }
    if (typed.type === 'message_delta' && typed.usage) {
      Object.assign(acc, anthropicUsage(acc.promptTokens, typed.usage.output_tokens));
    }
    return acc;
  },
};

function anthropicUsage(inputTokens?: number, outputTokens?: number): UsageInfo {
  const usage: UsageInfo = { promptTokens: inputTokens, completionTokens: outputTokens };
  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    usage.totalTokens = inputTokens + outputTokens;
  }
  return usage;
}

export function adapterFor(format: WireFormat): ChatAdapter {
  return format === 'anthropic' ? anthropicAdapter : openaiAdapter;
}

export interface StreamResult {
  text: string;
  /** Undefined if no frame in the stream carried usage. */
  usage?: UsageInfo;
}

/** Pull assistant text and token usage out of a raw SSE body, tolerating partial frames. */
export function collectStreamText(buffer: string, adapter: ChatAdapter): StreamResult {
  let text = '';
  const usage: UsageInfo = {};
  let sawUsage = false;
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload);
      text += adapter.streamDelta(event);
      // Compare the full serialized shape, not just prompt/completion, so a
      // usage frame carrying only `total_tokens` (or any other subset) is
      // still detected.
      const before = JSON.stringify(usage);
      adapter.accumulateStreamUsage(event, usage);
      if (JSON.stringify(usage) !== before) {
        sawUsage = true;
      }
    } catch {
      // Partial or non-JSON frame; skip it.
    }
  }
  return { text, usage: sawUsage ? usage : undefined };
}
