import { describe, expect, it, vi } from 'vitest';

import { MnemonicClient } from '../src/mnemonic/client.js';
import type { AppConfig } from '../src/config.js';

const baseConfig: AppConfig = {
  port: 8710,
  host: '0.0.0.0',
  logLevel: 'silent',
  librechat: {
    mongoUri: 'mongodb://localhost',
    userHeader: 'x-librechat-user-id',
    conversationHeader: 'x-librechat-conversation-id',
  },
  upstreams: [],
  mnemonic: {
    mode: 'spawn',
    command: 'node',
    args: [],
    headers: {},
    vaultPath: '/vault',
    projectRoot: '/projects',
    createProjectDirs: true,
    writeScope: 'global',
    recallScope: 'all',
    recallLimit: 6,
    minSimilarity: 0.3,
    timeoutMs: 20000,
    tag: 'librechat',
  },
  memory: {
    defaultEnabled: true,
    recallEnabled: true,
    writeMode: 'llm',
    maxContextChars: 4000,
    queryMessageCount: 3,
    queryMaxChars: 1500,
    maxPerTurn: 3,
    dedupeThreshold: 0.82,
    commandPrefix: '/memory',
    projectless: 'global',
  },
  extract: {
    timeoutMs: 30000,
  },
  mcp: {
    enabled: true,
    path: '/mcp',
  },
  cache: {
    noteBodyTtlMs: 300_000,
    recallTtlMs: 120_000,
    settingsTtlMs: 30_000,
    maxEntries: 5_000,
  },
  telemetry: {
    enabled: false,
    baseUrl: 'https://cloud.langfuse.com',
    environment: 'test',
  },
};

/**
 * The MnemonicClient connects lazily to a real MCP server. To test the queue
 * split without spawning a process, we mock the private connect() method to
 * return a fake client whose callTool resolves after a configurable delay.
 */
function createMockMnemonicClient(delays: { read?: number; write?: number } = {}) {
  const client = new MnemonicClient(baseConfig);

  // Mock the connect method to return a fake client
  const fakeClient = {
    callTool: vi.fn(async (request: { name: string; arguments: Record<string, unknown> }) => {
      const writeTools = new Set(['remember', 'forget', 'update']);
      const isWrite = writeTools.has(request.name);
      const delay = isWrite ? (delays.write ?? 50) : (delays.read ?? 10);
      await new Promise((r) => setTimeout(r, delay));
      return {
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: { action: request.name, results: [] },
        isError: false,
      };
    }),
    close: vi.fn(async () => {}),
    onclose: null,
  };

  // Access the private method via prototype hacking
  (client as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(
    async () => fakeClient,
  );

  return { client, fakeClient };
}

describe('MnemonicClient — queue split', () => {
  it('read does not wait behind a slow write', async () => {
    const { client } = createMockMnemonicClient({
      write: 200, // slow write
      read: 10, // fast read
    });

    // Start a write (200ms)
    const writePromise = client.call('remember', { title: 'test', content: 'test' });
    // Immediately start a read (should complete in ~10ms, not wait 200ms for write)
    const readStart = Date.now();
    const readResult = await client.call('recall', { query: 'test' });
    const readElapsed = Date.now() - readStart;

    expect(readResult.text).toBe('ok');
    // Read should complete well before the write (which takes 200ms)
    // Allow some margin for event loop overhead
    expect(readElapsed).toBeLessThan(150);

    // Clean up
    await writePromise;
    await client.close();
  });

  it('two writes serialise against each other', async () => {
    const { client } = createMockMnemonicClient({ write: 100 });

    const start = Date.now();
    // Start two writes concurrently
    await Promise.all([
      client.call('remember', { title: 'a', content: 'a' }),
      client.call('remember', { title: 'b', content: 'b' }),
    ]);
    const elapsed = Date.now() - start;

    // If writes serialise, total time is ~200ms (100 + 100).
    // If they ran in parallel, it would be ~100ms.
    expect(elapsed).toBeGreaterThanOrEqual(180);

    await client.close();
  });

  it('two reads serialise on the read queue (not parallel)', async () => {
    const { client } = createMockMnemonicClient({ read: 50 });

    const start = Date.now();
    await Promise.all([
      client.call('recall', { query: 'a' }),
      client.call('recall', { query: 'b' }),
    ]);
    const elapsed = Date.now() - start;

    // Reads serialise on the read queue, so total is ~100ms (50 + 50).
    // The benefit is that reads don't wait behind writes, not that reads
    // parallelise among themselves.
    expect(elapsed).toBeGreaterThanOrEqual(90);

    await client.close();
  });

  it('unknown tool defaults to read queue', async () => {
    const { client } = createMockMnemonicClient({
      write: 200,
      read: 10,
    });

    // Start a slow write
    const writePromise = client.call('remember', { title: 'test', content: 'test' });

    // Call an unknown tool — should go to the read queue, not wait for the write
    const readStart = Date.now();
    await client.call('unknownTool', {});
    const elapsed = Date.now() - readStart;

    // Should complete quickly (read queue), not wait for the write
    expect(elapsed).toBeLessThan(150);

    await writePromise;
    await client.close();
  });
});
