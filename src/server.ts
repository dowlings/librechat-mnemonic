import express, { type Express } from 'express';

import type { AppConfig } from './config.js';
import type { LibreChatStore } from './librechat/mongo.js';
import { logger } from './logger.js';
import { createMcpHandler } from './mcp/server.js';
import type { MemoryService } from './memory/service.js';
import type { Telemetry } from './telemetry.js';
import { createProxyHandler } from './proxy/handler.js';

export interface ServerDeps {
  config: AppConfig;
  store: LibreChatStore;
  memory: MemoryService;
  telemetry: Telemetry;
}

export function createApp(deps: ServerDeps): Express {
  const { config, store, memory, telemetry } = deps;
  const app = express();

  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      upstreams: config.upstreams.map((upstream) => upstream.name),
      telemetry: telemetry.enabled ? 'on' : 'off',
      cache: {
        ...memory.cacheStats,
        settings: store.settingsCacheStats,
      },
      // Call counters, so "is mnemonic timing out?" is answerable with a curl
      // rather than by grepping logs.
      mnemonic: memory.mnemonicStats,
    });
  });

  /*
   * Bodies are kept as raw buffers. Chat requests are parsed, mutated and
   * re-serialised deliberately; everything else is relayed byte for byte so
   * uploads and unusual content types survive the round trip.
   */
  const raw = express.raw({ type: () => true, limit: '64mb' });

  if (config.mcp.enabled) {
    app.all(config.mcp.path, raw, createMcpHandler(deps));
    logger.info({ path: config.mcp.path }, 'mcp endpoint enabled');
  }

  const proxy = createProxyHandler(deps);
  app.use('/:upstream', raw, proxy);

  app.use((_req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
  });

  return app;
}
