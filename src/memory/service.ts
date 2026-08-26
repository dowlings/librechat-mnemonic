import { createHash } from 'node:crypto';

import type { AppConfig } from '../config.js';
import { TtlCache } from '../cache.js';
import type { LibreChatStore } from '../librechat/mongo.js';
import { logger } from '../logger.js';
import type { MnemonicClient } from '../mnemonic/client.js';
import { resolveProjectDir } from '../mnemonic/projects.js';
import type {
  GetResponse,
  MemoryCandidate,
  MemoryContext,
  NoteBody,
  RecallResponse,
  RecallResultItem,
  RememberResponse,
} from './types.js';

export interface RecalledMemory extends RecallResultItem {
  content: string;
}

/**
 * The shared core. Both the proxy and the MCP endpoint go through this so they
 * cannot drift on scoping rules.
 *
 * Scoping model, and why:
 *
 * - Writes use `scope: "global"` by default, with `cwd` set to the LibreChat
 *   project's directory. mnemonic then stores the note in the main vault while
 *   stamping it with the detected project id (see `remember` in mnemonic's
 *   src/tools/remember.ts: the note carries `project` and `projectName`
 *   regardless of which vault it lands in). That is exactly "one global vault,
 *   partitioned by project".
 * - Reads use `scope: "all"` by default with the same `cwd`, so the chat sees
 *   its project's notes boosted plus unscoped global notes. Set
 *   MNEMONIC_RECALL_SCOPE=project for hard isolation.
 */
export class MemoryService {
  private readonly noteBodyCache: TtlCache<string, NoteBody>;
  private readonly recallCache: TtlCache<string, RecalledMemory[]>;

  constructor(
    private readonly config: AppConfig,
    private readonly mnemonic: MnemonicClient,
    private readonly store: LibreChatStore,
  ) {
    this.noteBodyCache = new TtlCache<string, NoteBody>(
      config.cache.noteBodyTtlMs,
      config.cache.maxEntries,
    );
    this.recallCache = new TtlCache<string, RecalledMemory[]>(
      config.cache.recallTtlMs,
      config.cache.maxEntries,
    );
  }

  /** Resolve the project context for a chat turn. */
  async resolveContext(
    userId: string | null,
    conversationId: string | null,
    options: { retries?: number } = {},
  ): Promise<MemoryContext> {
    const base: MemoryContext = { userId, conversationId, projectName: null, cwd: null };
    if (!conversationId) return base;

    const project = await this.store.getConversationProject(conversationId, {
      retries: options.retries ?? 0,
    });
    if (!project) return base;

    const dir = await resolveProjectDir(project.name, project.chatProjectId, {
      projectRoot: this.config.mnemonic.projectRoot,
      create: this.config.mnemonic.createProjectDirs,
    });

    if (!dir.usable) return base;

    return { ...base, projectName: project.name, cwd: dir.cwd };
  }

  /** Semantic search, hydrated with note bodies so the result is usable as context. */
  async recall(
    context: MemoryContext,
    query: string,
    overrides: { limit?: number; scope?: 'all' | 'project' | 'global' } = {},
  ): Promise<RecalledMemory[]> {
    if (!query.trim()) return [];

    // A chat with no project and projectless memory disabled reads nothing.
    if (!context.cwd && this.config.memory.projectless === 'off') return [];

    const scope = overrides.scope ?? this.config.mnemonic.recallScope;
    const limit = overrides.limit ?? this.config.mnemonic.recallLimit;

    // Check recall cache — retries and edits produce the same query.
    const cacheKey = `${context.conversationId ?? 'none'}:${scope}:${limit}:${hashString(query)}`;
    const cached = this.recallCache.get(cacheKey);
    if (cached) {
      logger.debug({ cacheKey, count: cached.length }, 'recall cache hit');
      return cached;
    }

    const args: Record<string, unknown> = {
      query,
      limit,
      scope,
      minSimilarity: this.config.mnemonic.minSimilarity,
    };
    if (context.cwd) args.cwd = context.cwd;
    // Without a project, "project" scope would match nothing; fall back to global.
    if (!context.cwd && scope === 'project') args.scope = 'global';

    let response: RecallResponse | undefined;
    try {
      const result = await this.mnemonic.call<RecallResponse>('recall', args);
      response = result.structured;
    } catch (error) {
      logger.error({ err: error, query: truncate(query, 120) }, 'recall failed');
      return [];
    }

    const results = response?.results ?? [];
    if (results.length === 0) return [];

    const ids = results.map((r) => r.id);
    const bodies = await this.getNotes(ids, context);
    const byId = new Map(bodies.map((note) => [note.id, note]));

    const hydrated = results.map((result) => ({
      ...result,
      content: byId.get(result.id)?.content ?? '',
    }));

    this.recallCache.set(cacheKey, hydrated);
    return hydrated;
  }

  async getNotes(ids: string[], context: MemoryContext): Promise<NoteBody[]> {
    if (ids.length === 0) return [];

    // Try to satisfy from cache first.
    const cached: NoteBody[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const hit = this.noteBodyCache.get(id);
      if (hit) cached.push(hit);
      else missing.push(id);
    }

    if (missing.length === 0) {
      logger.debug({ requested: ids.length, cached: cached.length }, 'note body cache full hit');
      return cached;
    }

    // Fetch only the missing ones.
    const args: Record<string, unknown> = { ids: missing };
    if (context.cwd) args.cwd = context.cwd;
    try {
      const result = await this.mnemonic.call<GetResponse>('get', args);
      const fetched = result.structured?.notes ?? [];
      for (const note of fetched) {
        this.noteBodyCache.set(note.id, note);
      }
      logger.debug(
        { requested: ids.length, cached: cached.length, fetched: fetched.length },
        'note body cache partial',
      );
      return [...cached, ...fetched];
    } catch (error) {
      logger.error({ err: error }, 'get failed');
      return cached;
    }
  }

  /**
   * Store a memory, skipping anything the vault already knows.
   *
   * `checkedForExisting: true` is honest here: we run the dedupe recall right above the write.
   */
  async save(
    context: MemoryContext,
    candidate: MemoryCandidate,
  ): Promise<{ saved: boolean; id?: string; reason?: string; duplicateTitle?: string }> {
    if (!context.cwd && this.config.memory.projectless === 'off') {
      return { saved: false, reason: 'projectless-writes-disabled' };
    }
  
    let duplicates = await this.findDuplicates(context, candidate);
    const candidateIsAutoExtracted = candidate.tags?.includes('auto-extracted') ?? false;
  
    // Forget any auto-extracted duplicates that a manually saved note should replace
    if (!candidateIsAutoExtracted) {
      const autoExtracted = duplicates.filter(
        (dup) => dup.tags?.includes('auto-extracted') ?? false,
      );
      for (const dup of autoExtracted) {
        await this.forget(context, dup.id);
      }
      if (autoExtracted.length > 0) {
        logger.info(
          { count: autoExtracted.length, ids: autoExtracted.map((d) => d.id), title: candidate.title },
          'replaced auto-extracted fragments with explicit save',
        );
      }
      // Remove forgotten duplicates so only real blockers remain.
      duplicates = duplicates.filter(
        (dup) => !(dup.tags?.includes('auto-extracted') ?? false),
      );
    }
  
    // Block if any duplicates remain
    if (duplicates.length > 0) {
      return { saved: false, id: duplicates[0]!.id, reason: 'duplicate', duplicateTitle: duplicates[0]!.title };
    }
  
    const tags = dedupeTags([...(candidate.tags ?? []), this.config.mnemonic.tag]);

    const args: Record<string, unknown> = {
      title: candidate.title,
      content: candidate.content,
      tags,
      scope: this.config.mnemonic.writeScope,
      checkedForExisting: true,
    };
    
    if (candidate.lifecycle) args.lifecycle = candidate.lifecycle;
    if (candidate.role) args.role = candidate.role;
    if (context.cwd) args.cwd = context.cwd;

    try {
      const result = await this.mnemonic.call<RememberResponse>('remember', args);
      const structured = result.structured;
      if (structured?.action === 'lint_error') {
        logger.warn({ issues: structured.issues, title: candidate.title }, 'memory rejected by lint');
        return { saved: false, reason: 'lint_error' };
      }
      logger.info(
        { id: structured?.id, project: context.projectName ?? '(none)', title: candidate.title },
        'memory saved',
      );
      this.invalidateRecallCache();
      return { saved: true, id: structured?.id };
    } catch (error) {
      logger.error({ err: error, title: candidate.title }, 'remember failed');
      return { saved: false, reason: 'error' };
    }
  }

  private async findDuplicates(
    context: MemoryContext,
    candidate: MemoryCandidate,
  ): Promise<RecallResultItem[]> {
    const query = `${candidate.title}\n${candidate.content}`.slice(0, 800);
    const args: Record<string, unknown> = {
      query,
      limit: 10,  // was 3 — an explicit save may overlap multiple fragments
      scope: context.cwd ? 'all' : 'global',
      minSimilarity: this.config.mnemonic.minSimilarity,
    };
    if (context.cwd) args.cwd = context.cwd;
  
    try {
      const result = await this.mnemonic.call<RecallResponse>('recall', args);
      const results = result.structured?.results ?? [];
      const threshold = this.config.memory.dedupeThreshold;
      return results.filter((item) => (item.boosted ?? item.score ?? 0) >= threshold);
    } catch (error) {
      logger.warn({ err: error }, 'dedupe check failed; saving anyway');
      return [];
    }
  }
  
  async forget(context: MemoryContext, id: string): Promise<boolean> {
    const args: Record<string, unknown> = { id };
    if (context.cwd) args.cwd = context.cwd;
    try {
      await this.mnemonic.call('forget', args);
      this.noteBodyCache.delete(id);
      this.invalidateRecallCache();
      return true;
    } catch (error) {
      logger.error({ err: error, id }, 'forget failed');
      return false;
    }
  }
  
  async update(
    context: MemoryContext,
    id: string,
    patch: { title?: string; content?: string; tags?: string[] },
  ): Promise<boolean> {
    const args: Record<string, unknown> = { id, ...patch };
    if (context.cwd) args.cwd = context.cwd;
    try {
      await this.mnemonic.call('update', args);
      this.noteBodyCache.delete(id);
      this.invalidateRecallCache();
      return true;
    } catch (error) {
      logger.error({ err: error, id }, 'update failed');
      return false;
    }
  }

  async list(
    context: MemoryContext,
    options: { tags?: string[]; scope?: 'project' | 'global' | 'all' } = {},
  ): Promise<unknown> {
    const args: Record<string, unknown> = { scope: options.scope ?? 'all' };
    if (options.tags?.length) args.tags = options.tags;
    if (context.cwd) args.cwd = context.cwd;
    const result = await this.mnemonic.call('list', args);
    return result.structured ?? result.text;
  }

  /**
   * Invalidate the recall cache after a write.
   *
   * Memories live in one global vault (see class docs): a note written from
   * conversation A can surface in conversation B's recall results whenever
   * they share a project (recall scope "all"/"project") or scope is
   * "global". Invalidating only the writing conversation's cache entries
   * would leave every other conversation's cache serving stale results, so
   * any write clears the whole recall cache rather than just the writer's
   * slice.
   */
  invalidateRecallCache(): void {
    this.recallCache.clear();
  }

  /** Expose cache stats for monitoring/logging. */
  get cacheStats() {
    return {
      noteBody: this.noteBodyCache.stats,
      recall: this.recallCache.stats,
    };
  }
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
