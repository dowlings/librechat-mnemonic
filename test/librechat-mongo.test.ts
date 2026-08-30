import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config.js';

/**
 * Regression coverage for project resolution.
 *
 * The `chatprojects._id` lookup only matches when the value is a real BSON
 * ObjectId — a plain string silently returns null, which showed up as every
 * saved note being stamped `project: (none)`. The fake collection below models
 * that strictness deliberately so a regression fails here instead of in
 * production.
 */

const state = vi.hoisted(() => ({
  conversations: [] as Array<{
    conversationId: string;
    user?: string;
    chatProjectId?: string | null;
  }>,
  chatProjects: [] as Array<{ _id: unknown; name: string; description?: string }>,
  /** Every `_id` filter value the store sent to `chatprojects`. */
  projectIdFilters: [] as unknown[],
  conversationLookups: 0,
}));

vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();

  const isOid = (value: unknown): value is InstanceType<typeof actual.ObjectId> =>
    value instanceof actual.ObjectId;

  // Mongo compares BSON types strictly: an ObjectId never equals a string.
  const bsonEquals = (a: unknown, b: unknown): boolean =>
    isOid(a) && isOid(b) ? a.equals(b) : !isOid(a) && !isOid(b) && a === b;

  class FakeMongoClient {
    async connect(): Promise<this> {
      return this;
    }
    async close(): Promise<void> {}
    db(name?: string) {
      return {
        databaseName: name ?? 'librechat',
        collection(collectionName: string) {
          return {
            async findOne(filter: Record<string, unknown>) {
              if (collectionName === 'conversations') {
                state.conversationLookups++;
                return (
                  state.conversations.find((doc) => doc.conversationId === filter.conversationId) ??
                  null
                );
              }
              if (collectionName === 'chatprojects') {
                state.projectIdFilters.push(filter._id);
                return state.chatProjects.find((doc) => bsonEquals(doc._id, filter._id)) ?? null;
              }
              return null;
            },
          };
        },
      };
    }
  }

  return { ...actual, MongoClient: FakeMongoClient };
});

// Imported after the mock so the store binds to the fake client.
const { LibreChatStore } = await import('../src/librechat/mongo.js');

const config = {
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
    slowCallMs: 5_000,
    statsIntervalMs: 0,
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
  extract: { timeoutMs: 30000 },
  mcp: { enabled: true, path: '/mcp' },
  cache: {
    noteBodyTtlMs: 300_000,
    recallTtlMs: 120_000,
    settingsTtlMs: 30_000,
    maxEntries: 5_000,
  },
  telemetry: { enabled: false, baseUrl: 'https://cloud.langfuse.com', environment: 'test' },
} as AppConfig;

const PROJECT_ID = '507f1f77bcf86cd799439011';

describe('LibreChatStore.getConversationProject', () => {
  beforeEach(() => {
    state.conversations = [];
    state.chatProjects = [];
    state.projectIdFilters = [];
    state.conversationLookups = 0;
  });

  it('resolves the project, querying chatprojects with a real ObjectId', async () => {
    state.conversations = [{ conversationId: 'conv-1', chatProjectId: PROJECT_ID }];
    state.chatProjects = [
      { _id: new ObjectId(PROJECT_ID), name: 'librechat-mnemonic', description: 'the proxy' },
    ];
    const store = new LibreChatStore(config);

    const project = await store.getConversationProject('conv-1');

    expect(project).toEqual({
      chatProjectId: PROJECT_ID,
      name: 'librechat-mnemonic',
      description: 'the proxy',
    });
    // The bug returned the id as a plain string, so the lookup never matched.
    expect(state.projectIdFilters).toHaveLength(1);
    expect(state.projectIdFilters[0]).toBeInstanceOf(ObjectId);
    await store.close();
  });

  it('passes ids that are not ObjectId-shaped through unchanged', async () => {
    state.conversations = [{ conversationId: 'conv-1', chatProjectId: 'not-an-object-id' }];
    state.chatProjects = [{ _id: 'not-an-object-id', name: 'string-keyed' }];
    const store = new LibreChatStore(config);

    const project = await store.getConversationProject('conv-1');

    expect(project?.name).toBe('string-keyed');
    expect(state.projectIdFilters[0]).toBe('not-an-object-id');
    await store.close();
  });

  it('returns null for a conversation with no project', async () => {
    state.conversations = [{ conversationId: 'conv-1', chatProjectId: null }];
    const store = new LibreChatStore(config);

    expect(await store.getConversationProject('conv-1')).toBeNull();
    expect(state.projectIdFilters).toHaveLength(0);
    await store.close();
  });

  it('returns null when the referenced project no longer exists', async () => {
    state.conversations = [{ conversationId: 'conv-1', chatProjectId: PROJECT_ID }];
    const store = new LibreChatStore(config);

    expect(await store.getConversationProject('conv-1')).toBeNull();
    await store.close();
  });

  it('caches a resolved project instead of re-querying', async () => {
    state.conversations = [{ conversationId: 'conv-1', chatProjectId: PROJECT_ID }];
    state.chatProjects = [{ _id: new ObjectId(PROJECT_ID), name: 'librechat-mnemonic' }];
    const store = new LibreChatStore(config);

    await store.getConversationProject('conv-1');
    await store.getConversationProject('conv-1');

    expect(state.conversationLookups).toBe(1);

    store.invalidateConversation('conv-1');
    await store.getConversationProject('conv-1');
    expect(state.conversationLookups).toBe(2);
    await store.close();
  });

  it('retries a conversation that has not been written yet', async () => {
    const store = new LibreChatStore(config);
    setTimeout(() => {
      state.conversations = [{ conversationId: 'conv-1', chatProjectId: PROJECT_ID }];
      state.chatProjects = [{ _id: new ObjectId(PROJECT_ID), name: 'librechat-mnemonic' }];
    }, 10);

    const project = await store.getConversationProject('conv-1', {
      retries: 3,
      retryDelayMs: 20,
    });

    expect(project?.name).toBe('librechat-mnemonic');
    expect(state.conversationLookups).toBeGreaterThan(1);
    await store.close();
  });
});
