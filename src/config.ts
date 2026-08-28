import { createRequire } from 'node:module';

import { z } from 'zod';

/**
 * All configuration is environment-driven so the service can be dropped into a
 * docker-compose stack without a config file. Everything has a working default
 * except the upstream routes and the LibreChat Mongo URI.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .refine((v) => Number.isInteger(v), { message: 'must be an integer' });

/** Like `int`, but rejects zero and negative values — for TTLs and caps that must be usable. */
const positiveInt = (fallback: number) =>
  int(fallback).refine((v) => v > 0, { message: 'must be a positive integer' });

const num = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number.parseFloat(v)))
    .refine((v) => Number.isFinite(v), { message: 'must be a number' });

/** A provider the proxy forwards to. */
export const upstreamSchema = z.object({
  /** Path prefix this upstream is mounted at, e.g. "openai" -> /openai/v1/... */
  name: z.string().min(1),
  /** Root URL of the provider, without the /v1 suffix for anthropic, with it for openai. */
  baseUrl: z.string().url(),
  /** Wire format. "openai" = /chat/completions, "anthropic" = /messages. */
  api: z.enum(['openai', 'anthropic']).default('openai'),
  /**
   * Optional static credential. When set it replaces the inbound Authorization
   * (openai) or x-api-key (anthropic) header. Leave unset to forward whatever
   * LibreChat sends, which is the usual arrangement.
   */
  apiKey: z.string().optional(),
  /**
   * Force `stream_options.include_usage: true` on OpenAI-format streaming
   * requests to this upstream, so the terminal SSE chunk always carries token
   * usage. Disable for an upstream that rejects unknown request params.
   */
  forceIncludeUsage: z.boolean().optional().default(true),
});

export type UpstreamConfig = z.infer<typeof upstreamSchema>;

export const memoryWriteModes = ['llm', 'explicit', 'off'] as const;
export type MemoryWriteMode = (typeof memoryWriteModes)[number];

export interface TelemetryConfig {
  enabled: boolean;
  publicKey?: string;
  secretKey?: string;
  baseUrl: string;
}

const rawSchema = z.object({
  PORT: int(8710),
  HOST: z.string().optional().default('0.0.0.0'),
  LOG_LEVEL: z.string().optional().default('info'),

  // ── LibreChat ──────────────────────────────────────────────────────────────
  LIBRECHAT_MONGO_URI: z.string().min(1),
  LIBRECHAT_MONGO_DB: z.string().optional(),
  LIBRECHAT_USER_HEADER: z.string().optional().default('x-librechat-user-id'),
  LIBRECHAT_CONVERSATION_HEADER: z
    .string()
    .optional()
    .default('x-librechat-conversation-id'),

  // ── Upstreams ──────────────────────────────────────────────────────────────
  UPSTREAMS: z.string().optional().default('[]'),

  // ── mnemonic ───────────────────────────────────────────────────────────────
  MNEMONIC_MODE: z.enum(['spawn', 'remote']).optional().default('spawn'),
  MNEMONIC_COMMAND: z.string().optional(),
  MNEMONIC_ARGS: z.string().optional().default(''),
  MNEMONIC_URL: z.string().optional(),
  MNEMONIC_HEADERS: z.string().optional().default('{}'),
  MNEMONIC_VAULT_PATH: z.string().optional().default('/vault'),
  MNEMONIC_PROJECT_ROOT: z.string().optional().default('/projects'),
  MNEMONIC_PROJECT_ROOT_CREATE: bool(true),
  MNEMONIC_WRITE_SCOPE: z.enum(['global', 'project']).optional().default('global'),
  MNEMONIC_RECALL_SCOPE: z.enum(['all', 'project', 'global']).optional().default('all'),
  MNEMONIC_RECALL_LIMIT: int(6),
  MNEMONIC_MIN_SIMILARITY: num(0.3),
  MNEMONIC_TIMEOUT_MS: int(20000),
  MNEMONIC_TAG: z.string().optional().default('librechat'),

  // ── Behaviour ──────────────────────────────────────────────────────────────
  MEMORY_DEFAULT_ENABLED: bool(true),
  MEMORY_RECALL_ENABLED: bool(true),
  MEMORY_WRITE_MODE: z.enum(memoryWriteModes).optional().default('llm'),
  MEMORY_MAX_CONTEXT_CHARS: int(4000),
  MEMORY_QUERY_MESSAGE_COUNT: int(3),
  MEMORY_QUERY_MAX_CHARS: int(1500),
  MEMORY_MAX_PER_TURN: int(3),
  MEMORY_DEDUPE_THRESHOLD: num(0.82),
  MEMORY_COMMAND_PREFIX: z.string().optional().default('/memory'),
  /** What to do in a chat that is not assigned to a LibreChat project. */
  MEMORY_PROJECTLESS: z.enum(['global', 'off']).optional().default('global'),

  // ── Extraction model (falls back to the chat request's own upstream) ───────
  EXTRACT_BASE_URL: z.string().optional(),
  EXTRACT_API_KEY: z.string().optional(),
  EXTRACT_MODEL: z.string().optional(),
  EXTRACT_TIMEOUT_MS: int(30000),

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  MCP_ENABLED: bool(true),
  MCP_PATH: z.string().optional().default('/mcp'),

  // ── Caching ────────────────────────────────────────────────────────────────
  CACHE_NOTE_BODY_TTL_MS: positiveInt(300_000),
  CACHE_RECALL_TTL_MS: positiveInt(120_000),
  CACHE_SETTINGS_TTL_MS: positiveInt(30_000),
  /** Shared entry cap for all three caches, so a long-running process can't grow them unbounded. */
  CACHE_MAX_ENTRIES: positiveInt(5_000),

  // ── Telemetry ──────────────────────────────────────────────────────────────
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().optional().default('https://cloud.langfuse.com'),
});

export interface AppConfig {
  port: number;
  host: string;
  logLevel: string;
  librechat: {
    mongoUri: string;
    mongoDb?: string;
    userHeader: string;
    conversationHeader: string;
  };
  upstreams: UpstreamConfig[];
  mnemonic: {
    mode: 'spawn' | 'remote';
    command: string;
    args: string[];
    url?: string;
    headers: Record<string, string>;
    vaultPath: string;
    projectRoot: string;
    createProjectDirs: boolean;
    writeScope: 'global' | 'project';
    recallScope: 'all' | 'project' | 'global';
    recallLimit: number;
    minSimilarity: number;
    timeoutMs: number;
    tag: string;
  };
  memory: {
    defaultEnabled: boolean;
    recallEnabled: boolean;
    writeMode: MemoryWriteMode;
    maxContextChars: number;
    queryMessageCount: number;
    queryMaxChars: number;
    maxPerTurn: number;
    dedupeThreshold: number;
    commandPrefix: string;
    projectless: 'global' | 'off';
  };
  extract: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    timeoutMs: number;
  };
  mcp: {
    enabled: boolean;
    path: string;
  };
  cache: {
    noteBodyTtlMs: number;
    recallTtlMs: number;
    settingsTtlMs: number;
    maxEntries: number;
  };
  telemetry: TelemetryConfig;
}

/**
 * Locate the bundled mnemonic when the operator has not named one.
 *
 * `@danielmarbach/mnemonic-mcp` is an optional dependency, so it is normally
 * right there in node_modules. Spawning its entrypoint with the current node
 * binary avoids depending on `node_modules/.bin` being on PATH, which it is
 * not when the process is started directly rather than through npm.
 */
export function resolveMnemonicCommand(explicit?: string): { command: string; args: string[] } {
  if (explicit) return { command: explicit, args: [] };

  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@danielmarbach/mnemonic-mcp/build/index.js');
    return { command: process.execPath, args: [entry] };
  } catch {
    // Not installed; assume it is on PATH and let the connection error say so.
    return { command: 'mnemonic', args: [] };
  }
}

function parseJson<T>(label: string, raw: string, fallback: T): T {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const raw = parsed.data;

  const upstreams = upstreamSchema
    .array()
    .parse(parseJson('UPSTREAMS', raw.UPSTREAMS, [] as unknown[]));

  const names = new Set<string>();
  for (const upstream of upstreams) {
    if (names.has(upstream.name)) {
      throw new Error(`Duplicate upstream name "${upstream.name}" in UPSTREAMS`);
    }
    names.add(upstream.name);
  }

  if (raw.MNEMONIC_MODE === 'remote' && !raw.MNEMONIC_URL) {
    throw new Error('MNEMONIC_MODE=remote requires MNEMONIC_URL');
  }

  const resolved = resolveMnemonicCommand(raw.MNEMONIC_COMMAND);

  return {
    port: raw.PORT,
    host: raw.HOST,
    logLevel: raw.LOG_LEVEL,
    librechat: {
      mongoUri: raw.LIBRECHAT_MONGO_URI,
      mongoDb: raw.LIBRECHAT_MONGO_DB,
      userHeader: raw.LIBRECHAT_USER_HEADER.toLowerCase(),
      conversationHeader: raw.LIBRECHAT_CONVERSATION_HEADER.toLowerCase(),
    },
    upstreams,
    mnemonic: {
      mode: raw.MNEMONIC_MODE,
      command: resolved.command,
      args: raw.MNEMONIC_ARGS
        ? [...resolved.args, ...raw.MNEMONIC_ARGS.split(' ').filter(Boolean)]
        : resolved.args,
      url: raw.MNEMONIC_URL,
      headers: parseJson('MNEMONIC_HEADERS', raw.MNEMONIC_HEADERS, {} as Record<string, string>),
      vaultPath: raw.MNEMONIC_VAULT_PATH,
      projectRoot: raw.MNEMONIC_PROJECT_ROOT,
      // Creating directories only makes sense when mnemonic shares our filesystem.
      createProjectDirs:
        raw.MNEMONIC_MODE === 'remote' ? false : raw.MNEMONIC_PROJECT_ROOT_CREATE,
      writeScope: raw.MNEMONIC_WRITE_SCOPE,
      recallScope: raw.MNEMONIC_RECALL_SCOPE,
      recallLimit: raw.MNEMONIC_RECALL_LIMIT,
      minSimilarity: raw.MNEMONIC_MIN_SIMILARITY,
      timeoutMs: raw.MNEMONIC_TIMEOUT_MS,
      tag: raw.MNEMONIC_TAG,
    },
    memory: {
      defaultEnabled: raw.MEMORY_DEFAULT_ENABLED,
      recallEnabled: raw.MEMORY_RECALL_ENABLED,
      writeMode: raw.MEMORY_WRITE_MODE,
      maxContextChars: raw.MEMORY_MAX_CONTEXT_CHARS,
      queryMessageCount: raw.MEMORY_QUERY_MESSAGE_COUNT,
      queryMaxChars: raw.MEMORY_QUERY_MAX_CHARS,
      maxPerTurn: raw.MEMORY_MAX_PER_TURN,
      dedupeThreshold: raw.MEMORY_DEDUPE_THRESHOLD,
      commandPrefix: raw.MEMORY_COMMAND_PREFIX,
      projectless: raw.MEMORY_PROJECTLESS,
    },
    extract: {
      baseUrl: raw.EXTRACT_BASE_URL,
      apiKey: raw.EXTRACT_API_KEY,
      model: raw.EXTRACT_MODEL,
      timeoutMs: raw.EXTRACT_TIMEOUT_MS,
    },
    mcp: {
      enabled: raw.MCP_ENABLED,
      path: raw.MCP_PATH,
    },
    cache: {
      noteBodyTtlMs: raw.CACHE_NOTE_BODY_TTL_MS,
      recallTtlMs: raw.CACHE_RECALL_TTL_MS,
      settingsTtlMs: raw.CACHE_SETTINGS_TTL_MS,
      maxEntries: raw.CACHE_MAX_ENTRIES,
    },
    telemetry: {
      enabled: !!(raw.LANGFUSE_PUBLIC_KEY && raw.LANGFUSE_SECRET_KEY),
      publicKey: raw.LANGFUSE_PUBLIC_KEY,
      secretKey: raw.LANGFUSE_SECRET_KEY,
      baseUrl: raw.LANGFUSE_BASE_URL,
    },
  };
}