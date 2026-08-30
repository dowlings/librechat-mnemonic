import { loadConfig } from './config.js';
import { LibreChatStore } from './librechat/mongo.js';
import { logger } from './logger.js';
import { MemoryService } from './memory/service.js';
import { MnemonicClient } from './mnemonic/client.js';
import { createApp } from './server.js';
import { createTelemetry } from './telemetry.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.upstreams.length === 0) {
    logger.warn('No UPSTREAMS configured; the proxy will 404 every request.');
  }

  const telemetry = createTelemetry(config.telemetry);
  const mnemonic = new MnemonicClient(config);
  const store = new LibreChatStore(config);
  const memory = new MemoryService(config, mnemonic, store);

  const app = createApp({ config, store, memory, telemetry });

  const server = app.listen(config.port, config.host, () => {
    logger.info(
      {
        port: config.port,
        upstreams: config.upstreams.map((upstream) => `${upstream.name} (${upstream.api})`),
        mnemonic: config.mnemonic.mode,
        writeMode: config.memory.writeMode,
        defaultEnabled: config.memory.defaultEnabled,
        telemetry: telemetry.enabled ? 'on' : 'off',
        cache: {
          noteBodyTtlMs: config.cache.noteBodyTtlMs,
          recallTtlMs: config.cache.recallTtlMs,
          settingsTtlMs: config.cache.settingsTtlMs,
        },
      },
      'librechat-mnemonic listening',
    );
  });

  /*
   * Opt-in heartbeat. The per-call lines only appear at `debug` (or when a call
   * is slow or fails), which is the right default for a busy proxy — but it
   * leaves an operator running at `info` with no baseline to compare a bad
   * period against. This prints one.
   */
  let statsTimer: NodeJS.Timeout | undefined;
  if (config.mnemonic.statsIntervalMs > 0) {
    statsTimer = setInterval(() => {
      logger.info(
        { mnemonic: memory.mnemonicStats, cache: memory.cacheStats },
        'mnemonic call stats',
      );
    }, config.mnemonic.statsIntervalMs);
    statsTimer.unref();
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    if (statsTimer) clearInterval(statsTimer);
    server.close();
    await Promise.allSettled([telemetry.flush(), mnemonic.close(), store.close()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error }, 'fatal startup error');
  process.exit(1);
});
