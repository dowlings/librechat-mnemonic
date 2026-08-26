import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const base = {
  LIBRECHAT_MONGO_URI: 'mongodb://mongo:27017/LibreChat',
  UPSTREAMS: JSON.stringify([
    { name: 'openai', baseUrl: 'https://api.openai.com', api: 'openai' },
  ]),
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);
    expect(config.port).toBe(8710);
    expect(config.memory.defaultEnabled).toBe(true);
    expect(config.memory.writeMode).toBe('llm');
    expect(config.mnemonic.writeScope).toBe('global');
    expect(config.mnemonic.recallScope).toBe('all');
    expect(config.mnemonic.mode).toBe('spawn');
    expect(config.mcp.enabled).toBe(true);
  });

  it('requires a mongo uri, because project resolution has no other source', () => {
    expect(() => loadConfig({ UPSTREAMS: '[]' } as NodeJS.ProcessEnv)).toThrow(
      /LIBRECHAT_MONGO_URI/,
    );
  });

  it('parses booleans the way an operator would expect', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(
        loadConfig({ ...base, MEMORY_DEFAULT_ENABLED: value } as NodeJS.ProcessEnv).memory
          .defaultEnabled,
      ).toBe(false);
    }
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(
        loadConfig({ ...base, MEMORY_DEFAULT_ENABLED: value } as NodeJS.ProcessEnv).memory
          .defaultEnabled,
      ).toBe(true);
    }
  });

  it('rejects duplicate upstream names', () => {
    const UPSTREAMS = JSON.stringify([
      { name: 'x', baseUrl: 'https://a.example' },
      { name: 'x', baseUrl: 'https://b.example' },
    ]);
    expect(() => loadConfig({ ...base, UPSTREAMS } as NodeJS.ProcessEnv)).toThrow(/Duplicate/);
  });

  it('rejects a malformed UPSTREAMS value with a useful message', () => {
    expect(() => loadConfig({ ...base, UPSTREAMS: '{not json' } as NodeJS.ProcessEnv)).toThrow(
      /UPSTREAMS is not valid JSON/,
    );
  });

  it('requires a url in remote mode', () => {
    expect(() => loadConfig({ ...base, MNEMONIC_MODE: 'remote' } as NodeJS.ProcessEnv)).toThrow(
      /requires MNEMONIC_URL/,
    );
  });

  it('never creates project directories in remote mode, since the filesystem is not ours', () => {
    const config = loadConfig({
      ...base,
      MNEMONIC_MODE: 'remote',
      MNEMONIC_URL: 'https://mnemonic.example/mcp',
      MNEMONIC_PROJECT_ROOT_CREATE: 'true',
    } as NodeJS.ProcessEnv);
    expect(config.mnemonic.createProjectDirs).toBe(false);
  });

  it('lower-cases header names so lookups against node headers work', () => {
    const config = loadConfig({
      ...base,
      LIBRECHAT_USER_HEADER: 'X-My-User',
    } as NodeJS.ProcessEnv);
    expect(config.librechat.userHeader).toBe('x-my-user');
  });

  // ── Cache config ────────────────────────────────────────────────────────────

  it('applies cache TTL defaults', () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);
    expect(config.cache.noteBodyTtlMs).toBe(300_000);
    expect(config.cache.recallTtlMs).toBe(120_000);
    expect(config.cache.settingsTtlMs).toBe(30_000);
    expect(config.cache.maxEntries).toBe(5_000);
  });

  it('parses custom cache TTLs', () => {
    const config = loadConfig({
      ...base,
      CACHE_NOTE_BODY_TTL_MS: '600000',
      CACHE_RECALL_TTL_MS: '5000',
      CACHE_SETTINGS_TTL_MS: '10000',
      CACHE_MAX_ENTRIES: '100',
    } as NodeJS.ProcessEnv);
    expect(config.cache.noteBodyTtlMs).toBe(600_000);
    expect(config.cache.recallTtlMs).toBe(5_000);
    expect(config.cache.settingsTtlMs).toBe(10_000);
    expect(config.cache.maxEntries).toBe(100);
  });

  it('rejects zero or negative cache TTLs and max entries', () => {
    for (const key of [
      'CACHE_NOTE_BODY_TTL_MS',
      'CACHE_RECALL_TTL_MS',
      'CACHE_SETTINGS_TTL_MS',
      'CACHE_MAX_ENTRIES',
    ]) {
      for (const value of ['0', '-1']) {
        expect(() => loadConfig({ ...base, [key]: value } as NodeJS.ProcessEnv)).toThrow(
          /positive integer/,
        );
      }
    }
  });

  it('rejects malformed decimal cache TTLs and max entries', () => {
    for (const key of [
      'CACHE_NOTE_BODY_TTL_MS',
      'CACHE_RECALL_TTL_MS',
      'CACHE_SETTINGS_TTL_MS',
      'CACHE_MAX_ENTRIES',
    ]) {
      for (const value of ['1.5', '-1.5', 'NaN', '1,000']) {
        expect(() => loadConfig({ ...base, [key]: value } as NodeJS.ProcessEnv)).toThrow(
          /must be an integer/,
        );
      }
    }
  });

  // ── Telemetry config ────────────────────────────────────────────────────────

  it('disables telemetry when no keys are set', () => {
    const config = loadConfig(base as NodeJS.ProcessEnv);
    expect(config.telemetry.enabled).toBe(false);
    expect(config.telemetry.publicKey).toBeUndefined();
    expect(config.telemetry.secretKey).toBeUndefined();
    expect(config.telemetry.baseUrl).toBe('https://cloud.langfuse.com');
  });

  it('enables telemetry when both keys are present', () => {
    const config = loadConfig({
      ...base,
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
    } as NodeJS.ProcessEnv);
    expect(config.telemetry.enabled).toBe(true);
    expect(config.telemetry.publicKey).toBe('pk-lf-test');
    expect(config.telemetry.secretKey).toBe('sk-lf-test');
  });

  it('does not enable telemetry with only a public key', () => {
    const config = loadConfig({
      ...base,
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
    } as NodeJS.ProcessEnv);
    expect(config.telemetry.enabled).toBe(false);
  });

  it('honours a custom Langfuse base URL', () => {
    const config = loadConfig({
      ...base,
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_BASE_URL: 'https://langfuse.self-hosted.example',
    } as NodeJS.ProcessEnv);
    expect(config.telemetry.baseUrl).toBe('https://langfuse.self-hosted.example');
  });
});