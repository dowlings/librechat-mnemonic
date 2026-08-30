import { describe, expect, it } from 'vitest';

import {
  DATETIME_BLOCK_MARKER,
  MEMORY_BLOCK_MARKER,
  buildDateTimeBlock,
  buildMemoryBlock,
  buildRecallQuery,
  injectSystemMessage,
  messageText,
} from '../src/proxy/inject.js';
import type { RecalledMemory } from '../src/memory/service.js';
import type { MemoryContext } from '../src/memory/types.js';

const context: MemoryContext = {
  userId: 'u1',
  conversationId: 'c1',
  projectName: 'Home Network',
  cwd: '/projects/Home Network',
};

function memory(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    id: 'note-1',
    title: 'The NAS runs NFS v4',
    score: 0.7,
    vault: 'main-vault',
    content: 'Exports live under /mnt and use NFS v4 with soft mounts.',
    ...overrides,
  };
}

describe('messageText', () => {
  it('handles plain strings', () => {
    expect(messageText('hello')).toBe('hello');
  });

  it('flattens content-part arrays from either provider', () => {
    expect(
      messageText([
        { type: 'text', text: 'one' },
        { type: 'image', source: {} },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one\ntwo');
  });

  it('returns empty string for anything else', () => {
    expect(messageText(undefined)).toBe('');
    expect(messageText(42)).toBe('');
  });
});

describe('buildRecallQuery', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'an answer full of distracting words' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'another answer' },
    { role: 'user', content: 'third question' },
  ];

  it('uses only user turns, so recall follows intent not the model output', () => {
    const query = buildRecallQuery(messages, { messageCount: 3, maxChars: 1000 });
    expect(query).toBe('first question\n\nsecond question\n\nthird question');
    expect(query).not.toContain('answer');
  });

  it('takes the most recent turns when the window is smaller', () => {
    expect(buildRecallQuery(messages, { messageCount: 1, maxChars: 1000 })).toBe('third question');
  });

  it('keeps the tail when truncating, because the latest turn matters most', () => {
    const long = [{ role: 'user', content: 'a'.repeat(50) + 'ZZZ' }];
    const query = buildRecallQuery(long, { messageCount: 3, maxChars: 10 });
    expect(query).toHaveLength(10);
    expect(query.endsWith('ZZZ')).toBe(true);
  });

  it('returns empty when there is nothing from the user', () => {
    expect(
      buildRecallQuery([{ role: 'assistant', content: 'hi' }], { messageCount: 3, maxChars: 100 }),
    ).toBe('');
  });
});

describe('buildMemoryBlock', () => {
  it('returns null when nothing was recalled', () => {
    expect(buildMemoryBlock([], context, 4000)).toBeNull();
  });

  it('includes the marker, the project name, and the note body', () => {
    const block = buildMemoryBlock([memory()], context, 4000);
    expect(block).toContain(MEMORY_BLOCK_MARKER);
    expect(block).toContain('Home Network');
    expect(block).toContain('Exports live under /mnt');
    expect(block).toContain('note-1');
  });

  it('frames memories as background, not as instructions', () => {
    const block = buildMemoryBlock([memory()], context, 4000)!;
    expect(block).toMatch(/may be out of date/i);
    expect(block).toMatch(/Prefer what the user says now/i);
  });

  it('respects the character budget', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      memory({ id: `note-${index}`, content: 'x'.repeat(500) }),
    );
    const block = buildMemoryBlock(many, context, 2000)!;
    expect(block.length).toBeLessThanOrEqual(2200);
  });

  it('omits the project line for an unassigned chat', () => {
    const block = buildMemoryBlock([memory()], { ...context, projectName: null, cwd: null }, 4000)!;
    expect(block).not.toContain('scoped to the project');
  });
});

describe('buildDateTimeBlock', () => {
  // 2026-08-30T04:05:06.789Z — a Sunday.
  const at = new Date(Date.UTC(2026, 7, 30, 4, 5, 6, 789));

  it('carries the marker, ISO UTC, and unix seconds', () => {
    const block = buildDateTimeBlock(at);
    expect(block).toContain(DATETIME_BLOCK_MARKER);
    expect(block).toContain('2026-08-30T04:05:06Z');
    expect(block).toContain(String(Math.floor(at.getTime() / 1000)));
  });

  it('drops milliseconds, which the model would only echo back', () => {
    expect(buildDateTimeBlock(at)).not.toContain('.789');
  });

  it('spells out the weekday and month so the model does not have to compute them', () => {
    expect(buildDateTimeBlock(at)).toContain('Sunday, 30 August 2026');
  });

  it('tells the model to resolve relative dates against it', () => {
    expect(buildDateTimeBlock(at)).toMatch(/today/i);
  });
});

describe('injectSystemMessage', () => {
  const make = (content: string) => ({ role: 'system', content });

  it('inserts after leading system messages so operator instructions stay first', () => {
    const messages = [
      { role: 'system', content: 'operator rules' },
      { role: 'user', content: 'hi' },
    ];
    const next = injectSystemMessage(messages, 'BLOCK', make, MEMORY_BLOCK_MARKER);
    expect(next.map((m) => m.content)).toEqual(['operator rules', 'BLOCK', 'hi']);
  });

  it('inserts first when there are no system messages', () => {
    const next = injectSystemMessage(
      [{ role: 'user', content: 'hi' }],
      'BLOCK',
      make,
      MEMORY_BLOCK_MARKER,
    );
    expect(next[0]?.content).toBe('BLOCK');
  });

  it('does not inject twice', () => {
    const messages = [{ role: 'system', content: `x ${MEMORY_BLOCK_MARKER} y` }];
    const next = injectSystemMessage(messages, 'BLOCK', make, MEMORY_BLOCK_MARKER);
    expect(next).toHaveLength(1);
  });

  it('dedupes per marker, so one block does not suppress the other', () => {
    const messages = [{ role: 'system', content: `x ${MEMORY_BLOCK_MARKER} y` }];
    const next = injectSystemMessage(messages, 'DATE', make, DATETIME_BLOCK_MARKER);
    expect(next).toHaveLength(2);
    expect(next[1]?.content).toBe('DATE');
  });

  it('does not mutate the caller array', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    injectSystemMessage(messages, 'BLOCK', make, MEMORY_BLOCK_MARKER);
    expect(messages).toHaveLength(1);
  });
});
