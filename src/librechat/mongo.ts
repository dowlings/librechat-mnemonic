import { MongoClient, ObjectId, type Collection, type Db } from 'mongodb';

import { TtlCache } from '../cache.js';
import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Read-only access to LibreChat's own collections, plus one collection of our
 * own for per-chat toggles.
 *
 * Verified against LibreChat v0.8.7:
 * - `conversations`  keyed by the string field `conversationId`, carries
 *                    `chatProjectId` (string, nullable) and `user`.
 * - `chatprojects`   the ChatProject model's explicit collection name, with
 *                    `name`, `description` and `user`.
 *
 * We never write to either.
 */

const SETTINGS_COLLECTION = 'librechat_mnemonic_settings';

export interface ConversationProject {
  chatProjectId: string;
  name: string;
  description?: string;
}

interface ConversationDoc {
  conversationId: string;
  user?: string;
  chatProjectId?: string | null;
}

interface ChatProjectDoc {
  _id: unknown;
  name: string;
  description?: string;
  user?: string;
}

export interface MemorySetting {
  enabled: boolean;
  /** Where the value came from, for `/memory status`. */
  source: 'conversation' | 'user' | 'default';
}

export class LibreChatStore {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connecting: Promise<Db> | null = null;

  /**
   * Circuit breaker. Without it, a Mongo outage costs every request the full
   * server-selection timeout, three times over, and the chat crawls. Failing
   * fast degrades to "no project scoping" instead, which is the right
   * behaviour: memory is a nice-to-have, the conversation is not.
   */
  private breakerOpenUntil = 0;
  private static readonly BREAKER_COOLDOWN_MS = 15_000;

  /** conversationId -> project (or null for "checked, none"), short TTL. */
  private readonly projectCache = new Map<string, { value: ConversationProject | null; at: number }>();
  private readonly projectCacheTtlMs = 30_000;

  /** (userId, conversationId) -> MemorySetting, configurable TTL. */
  private readonly settingsCache: TtlCache<string, MemorySetting>;

  constructor(private readonly config: AppConfig) {
    this.settingsCache = new TtlCache<string, MemorySetting>(config.cache.settingsTtlMs);
  }

  private async connect(): Promise<Db> {
    if (this.db) return this.db;

    if (Date.now() < this.breakerOpenUntil) {
      throw new Error('LibreChat mongo is unavailable (circuit open)');
    }

    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new MongoClient(this.config.librechat.mongoUri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000,
      });
      await client.connect();
      this.client = client;
      this.db = this.config.librechat.mongoDb
        ? client.db(this.config.librechat.mongoDb)
        : client.db();
      this.breakerOpenUntil = 0;
      logger.info({ db: this.db.databaseName }, 'connected to LibreChat mongo');
      return this.db;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      this.client = null;
      this.db = null;
      this.breakerOpenUntil = Date.now() + LibreChatStore.BREAKER_COOLDOWN_MS;
      logger.error(
        { err: error, cooldownMs: LibreChatStore.BREAKER_COOLDOWN_MS },
        'mongo connection failed; pausing project lookups',
      );
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Resolve the LibreChat project a conversation belongs to.
   *
   * Returns null when the chat is unassigned, and also when the conversation
   * document does not exist yet. That second case is real: on the very first
   * turn of a brand new chat the document may not have been written. We retry
   * briefly, and the post-turn memory write resolves correctly regardless
   * because by then the conversation has been saved.
   */
  async getConversationProject(
    conversationId: string,
    options: { retries?: number; retryDelayMs?: number } = {},
  ): Promise<ConversationProject | null> {
    const cached = this.projectCache.get(conversationId);
    if (cached && Date.now() - cached.at < this.projectCacheTtlMs) {
      return cached.value;
    }

    const retries = options.retries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 250;

    try {
      const db = await this.connect();
      const conversations = db.collection<ConversationDoc>('conversations');

      let convo: ConversationDoc | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        convo = await conversations.findOne(
          { conversationId },
          { projection: { chatProjectId: 1, user: 1 } },
        );
        if (convo) break;
        if (attempt < retries) await delay(retryDelayMs);
      }

      if (!convo?.chatProjectId) {
        // Only cache a definitive "no project" when we actually saw the convo.
        if (convo) this.projectCache.set(conversationId, { value: null, at: Date.now() });
        return null;
      }

      const projects = db.collection('chatprojects');
      const project = (await projects.findOne(
        { _id: toObjectIdLike(convo.chatProjectId) } as never,
        { projection: { name: 1, description: 1 } },
      )) as ChatProjectDoc | null;

      if (!project?.name) {
        this.projectCache.set(conversationId, { value: null, at: Date.now() });
        return null;
      }

      const value: ConversationProject = {
        chatProjectId: convo.chatProjectId,
        name: project.name,
        description: project.description,
      };
      this.projectCache.set(conversationId, { value, at: Date.now() });
      return value;
    } catch (error) {
      logger.error({ err: error, conversationId }, 'failed to resolve conversation project');
      return null;
    }
  }

  /** Drop a cached project mapping, e.g. after a chat is moved between projects. */
  invalidateConversation(conversationId: string): void {
    this.projectCache.delete(conversationId);
  }

  private settingsCacheKey(userId: string | null, conversationId: string | null): string {
    return `${userId ?? 'none'}:${conversationId ?? 'none'}`;
  }

  /** Resolve whether memory is on for this chat: conversation, then user, then config default. */
  async getMemorySetting(userId: string | null, conversationId: string | null): Promise<MemorySetting> {
    const cacheKey = this.settingsCacheKey(userId, conversationId);
    const cached = this.settingsCache.get(cacheKey);
    if (cached) return cached;

    try {
      const collection = await this.settings();
      if (conversationId) {
        const convo = await collection.findOne({ _id: `conv:${conversationId}` as never });
        if (convo && typeof convo.enabled === 'boolean') {
          const setting: MemorySetting = { enabled: convo.enabled, source: 'conversation' };
          this.settingsCache.set(cacheKey, setting);
          return setting;
        }
      }
      if (userId) {
        const user = await collection.findOne({ _id: `user:${userId}` as never });
        if (user && typeof user.enabled === 'boolean') {
          const setting: MemorySetting = { enabled: user.enabled, source: 'user' };
          this.settingsCache.set(cacheKey, setting);
          return setting;
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'failed to read memory setting; falling back to default');
    }
    const setting: MemorySetting = { enabled: this.config.memory.defaultEnabled, source: 'default' };
    this.settingsCache.set(cacheKey, setting);
    return setting;
  }

  async setConversationMemory(
    conversationId: string,
    userId: string | null,
    enabled: boolean,
  ): Promise<void> {
    const collection = await this.settings();
    await collection.updateOne(
      { _id: `conv:${conversationId}` as never },
      { $set: { enabled, userId, kind: 'conversation', updatedAt: new Date() } },
      { upsert: true },
    );
    // Invalidate cache so the next read sees the new value immediately.
    this.settingsCache.delete(this.settingsCacheKey(userId, conversationId));
  }

  async clearConversationMemory(conversationId: string): Promise<void> {
    const collection = await this.settings();
    await collection.deleteOne({ _id: `conv:${conversationId}` as never });
    // Clear all cache entries that include this conversationId.
    this.settingsCache.clear();
  }

  async setUserDefaultMemory(userId: string, enabled: boolean): Promise<void> {
    const collection = await this.settings();
    await collection.updateOne(
      { _id: `user:${userId}` as never },
      { $set: { enabled, kind: 'user', updatedAt: new Date() } },
      { upsert: true },
    );
    // Clear all cache entries that include this userId.
    this.settingsCache.clear();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.db = null;
    if (client) await client.close().catch(() => undefined);
  }

  get settingsCacheStats() {
    return this.settingsCache.stats;
  }
}

/**
 * `chatProjectId` is stored on the conversation as a string. Mongo needs an
 * ObjectId to match `_id` in the `chatprojects` collection.
 */
function toObjectIdLike(id: string): unknown {
  return ObjectId.isValid(id) ? new ObjectId(id) : id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}