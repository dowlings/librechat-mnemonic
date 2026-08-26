import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createTelemetry } from '../src/telemetry.js';

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
    enabled: false,
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
  },
};

function createMockStore(settingsStats: { hits: number; misses: number; size: number; hitRate: number }) {
  return { settingsCacheStats: settingsStats };
}

function createMockMemory(cacheStats: {
  noteBody: { hits: number; misses: number; size: number; hitRate: number };
  recall: { hits: number; misses: number; size: number; hitRate: number };
}) {
  return { cacheStats };
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('/healthz', () => {
  it('reports note body, recall, and settings cache stats', async () => {
    const memory = createMockMemory({
      noteBody: { hits: 42, misses: 3, size: 12, hitRate: 0.93 },
      recall: { hits: 8, misses: 15, size: 5, hitRate: 0.35 },
    });
    const store = createMockStore({ hits: 20, misses: 4, size: 6, hitRate: 0.83 });

    const app = createApp({
      config: baseConfig,
      store: store as never,
      memory: memory as never,
      telemetry: createTelemetry(baseConfig.telemetry),
    });

    const { url, close } = await listen(app);
    try {
      const res = await fetch(`${url}/healthz`);
      const body = (await res.json()) as {
        ok: boolean;
        telemetry: string;
        cache: { noteBody: unknown; recall: unknown; settings: unknown };
      };

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.telemetry).toBe('off');
      expect(body.cache.noteBody).toEqual(memory.cacheStats.noteBody);
      expect(body.cache.recall).toEqual(memory.cacheStats.recall);
      expect(body.cache.settings).toEqual(store.settingsCacheStats);
    } finally {
      await close();
    }
  });
});
