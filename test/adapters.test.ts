import { describe, expect, it } from 'vitest';

import {
  adapterFor,
  anthropicAdapter,
  collectStreamText,
  openaiAdapter,
} from '../src/proxy/adapters.js';
import { MEMORY_BLOCK_MARKER } from '../src/proxy/inject.js';

const MARKER = MEMORY_BLOCK_MARKER;
const BLOCK = `${MARKER}\nBLOCK`;

describe('openai adapter', () => {
  it('injects a system message after existing system messages', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hi' },
      ],
    };
    const next = openaiAdapter.inject(body, BLOCK, MARKER) as typeof body;
    expect(next.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(next.messages[1]?.content).toBe(BLOCK);
    // Original untouched.
    expect(body.messages).toHaveLength(2);
  });

  it('skips a body that already carries the marker', () => {
    const body = { messages: [{ role: 'system', content: BLOCK }] };
    const next = openaiAdapter.inject(body, BLOCK, MARKER) as typeof body;
    expect(next.messages).toHaveLength(1);
  });

  it('injects a second block with a different marker', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const once = openaiAdapter.inject(body, BLOCK, MARKER) as typeof body;
    const twice = openaiAdapter.inject(once, '<!-- other -->\nOTHER', '<!-- other -->') as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(twice.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
  });

  it('reads the assistant reply from a completion', () => {
    expect(
      openaiAdapter.responseText({
        choices: [{ message: { role: 'assistant', content: 'the answer' } }],
      }),
    ).toBe('the answer');
  });

  it('reads deltas from stream chunks', () => {
    expect(openaiAdapter.streamDelta({ choices: [{ delta: { content: 'ab' } }] })).toBe('ab');
    expect(openaiAdapter.streamDelta({ choices: [{ delta: {} }] })).toBe('');
  });

  it('reads usage from a non-streaming response', () => {
    expect(
      openaiAdapter.responseUsage({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it('returns undefined usage when the response has none', () => {
    expect(openaiAdapter.responseUsage({ choices: [] })).toBeUndefined();
  });

  it('accumulates usage from the terminal usage-bearing stream chunk', () => {
    const acc = {};
    openaiAdapter.accumulateStreamUsage({ choices: [{ delta: { content: 'x' } }] }, acc);
    expect(acc).toEqual({});
    openaiAdapter.accumulateStreamUsage(
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } },
      acc,
    );
    expect(acc).toEqual({ promptTokens: 3, completionTokens: 7, totalTokens: 10 });
  });
});

describe('anthropic adapter', () => {
  it('appends to a string system prompt', () => {
    const next = anthropicAdapter.inject({ system: 'rules', messages: [] }, BLOCK, MARKER) as {
      system: string;
    };
    expect(next.system).toBe(`rules\n\n${BLOCK}`);
  });

  it('appends a text block to an array system prompt', () => {
    const next = anthropicAdapter.inject(
      { system: [{ type: 'text', text: 'rules' }], messages: [] },
      BLOCK,
      MARKER,
    ) as { system: Array<{ type: string; text: string }> };
    expect(next.system).toHaveLength(2);
    expect(next.system[1]).toEqual({ type: 'text', text: BLOCK });
  });

  it('sets the system prompt when there was none', () => {
    const next = anthropicAdapter.inject({ messages: [] }, BLOCK, MARKER) as { system: string };
    expect(next.system).toBe(BLOCK);
  });

  it('does not append twice, for either system prompt shape', () => {
    const fromString = anthropicAdapter.inject(
      { system: `rules\n\n${BLOCK}`, messages: [] },
      BLOCK,
      MARKER,
    ) as { system: string };
    expect(fromString.system).toBe(`rules\n\n${BLOCK}`);

    const fromArray = anthropicAdapter.inject(
      { system: [{ type: 'text', text: BLOCK }], messages: [] },
      BLOCK,
      MARKER,
    ) as { system: Array<{ type: string; text: string }> };
    expect(fromArray.system).toHaveLength(1);
  });

  it('reads text out of a messages response', () => {
    expect(
      anthropicAdapter.responseText({
        content: [
          { type: 'thinking', thinking: 'ignored' },
          { type: 'text', text: 'the ' },
          { type: 'text', text: 'answer' },
        ],
      }),
    ).toBe('the answer');
  });

  it('reads only text deltas from the stream', () => {
    expect(
      anthropicAdapter.streamDelta({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'ab' },
      }),
    ).toBe('ab');
    expect(anthropicAdapter.streamDelta({ type: 'message_start' })).toBe('');
  });

  it('reads usage from a non-streaming response', () => {
    expect(
      anthropicAdapter.responseUsage({
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
    ).toEqual({ promptTokens: 12, completionTokens: 8, totalTokens: 20 });
  });

  it('returns undefined usage when the response has none', () => {
    expect(anthropicAdapter.responseUsage({ content: [] })).toBeUndefined();
  });

  it('accumulates input tokens from message_start and output tokens from message_delta', () => {
    // message_start's own output_tokens is a meaningless placeholder (generation
    // hasn't happened yet) so it must not overwrite a later message_delta count.
    const acc = {};
    anthropicAdapter.accumulateStreamUsage(
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      acc,
    );
    expect(acc).toEqual({ promptTokens: 12 });
    anthropicAdapter.accumulateStreamUsage(
      { type: 'message_delta', usage: { output_tokens: 9 } },
      acc,
    );
    expect(acc).toEqual({ promptTokens: 12, completionTokens: 9, totalTokens: 21 });
  });
});

describe('collectStreamText', () => {
  it('reassembles an openai SSE body', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(collectStreamText(sse, openaiAdapter)).toEqual({
      text: 'Hello world',
      usage: undefined,
    });
  });

  it('reassembles an anthropic SSE body including event lines', () => {
    const sse = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    expect(collectStreamText(sse, anthropicAdapter)).toEqual({ text: 'Hi', usage: undefined });
  });

  it('ignores truncated or malformed frames rather than throwing', () => {
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"del';
    expect(collectStreamText(sse, openaiAdapter)).toEqual({ text: 'ok', usage: undefined });
  });

  it('captures usage from the terminal openai usage chunk', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    expect(collectStreamText(sse, openaiAdapter)).toEqual({
      text: 'Hello',
      usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
    });
  });

  it('captures usage split across anthropic message_start and message_delta', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":3}}',
      '',
    ].join('\n');
    expect(collectStreamText(sse, anthropicAdapter)).toEqual({
      text: 'Hi',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });
});

describe('adapterFor', () => {
  it('maps the wire format', () => {
    expect(adapterFor('anthropic')).toBe(anthropicAdapter);
    expect(adapterFor('openai')).toBe(openaiAdapter);
  });
});
