import type { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppConfig } from '../config.js';
import type { LibreChatStore } from '../librechat/mongo.js';
import { logger } from '../logger.js';
import type { MemoryService } from '../memory/service.js';
import type { Telemetry } from '../telemetry.js';

/**
 * The explicit half of the integration.
 *
 * The proxy handles the automatic path. These tools exist for the times the
 * automatic path is not enough: searching memory mid-answer, correcting
 * something that was recorded wrong, or deliberately writing a note the
 * extractor would not have picked up.
 *
 * Stateless by design: one server and transport per request, with project
 * context taken from the same headers the proxy uses. That keeps it compatible
 * with LibreChat's request-scoped MCP connections.
 */
export const SERVER_INSTRUCTIONS = `This server exposes the user's long-term memory vault (mnemonic), scoped to the current LibreChat project.
Relevant memories are already injected into your context automatically. Use these tools when that is not enough:
- search_memory when the user refers to something from a past conversation that is not in your context.
- save_memory when the user asks you to remember something specific, or states a durable decision worth keeping.
- update_memory or forget_memory when the user corrects or retracts something previously stored.
- list_memory when you need to see what notes exist in the vault without searching for specific terms.
Do not call save_memory for routine conversation. Automatic extraction already handles the ordinary case, and duplicate notes make recall worse.`;

export interface McpDeps {
  config: AppConfig;
  store: LibreChatStore;
  memory: MemoryService;
  telemetry: Telemetry;
}

/** Tool result shape — only the fields withTelemetry inspects. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Exported for tests; production code goes through `createMcpHandler`. */
export function buildServer(
  deps: McpDeps,
  userId: string | null,
  conversationId: string | null,
): McpServer {
  const { config, store, memory, telemetry } = deps;
  const server = new McpServer(
    { name: 'librechat-mnemonic', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const context = () => memory.resolveContext(userId, conversationId);

  /**
   * Wrap a tool handler with Langfuse tracing. Creates a trace per MCP tool
   * call, named "mcp-tool" with the tool name and user/conversation context
   * as metadata. A single span covers the tool's execution. Both the trace and
   * the span carry the tool arguments as input and the tool result as output,
   * so a Langfuse trace shows what was asked and what came back rather than
   * just the tool name.
   *
   * Most handlers report failure by returning `{ isError: true }` rather than
   * throwing — the wrapper inspects the result to record the correct span
   * status. If telemetry is disabled (NoopTelemetry), the wrapper is a
   * pass-through — no overhead.
   */
  function withTelemetry<TArgs extends Record<string, unknown>>(
    toolName: string,
    handler: (args: TArgs) => Promise<ToolResult>,
  ): (args: TArgs) => Promise<ToolResult> {
    return async (args: TArgs) => {
      const trace = telemetry.trace({
        name: 'mcp-tool',
        sessionId: conversationId ?? undefined,
        userId: userId ?? undefined,
        metadata: { tool: toolName },
        input: args,
      });
      const span = trace.span({ name: toolName, input: args });
      let output: unknown;
      try {
        const result = await handler(args);
        output = toolOutput(result);
        span.end({
          metadata: {
            status: result.isError === true ? 'error' : 'ok',
            ...(result.isError === true
              ? { error: result.content[0]?.text ?? 'unknown error' }
              : {}),
          },
          output,
        });
        return result;
      } catch (error) {
        output = { error: error instanceof Error ? error.message : String(error) };
        span.end({
          metadata: {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          },
          output,
        });
        throw error;
      } finally {
        trace.end({ output });
      }
    };
  }

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description:
        'Semantic search over the memory vault, scoped to the current project plus global notes. Use when the user refers to earlier context you do not have.',
      inputSchema: {
        query: z.string().describe('Natural-language description of what you are looking for.'),
        limit: z.number().int().min(1).max(20).optional(),
        scope: z
          .enum(['project', 'global', 'all'])
          .optional()
          .describe('Defaults to the server setting; "project" restricts to this chat project.'),
      },
    },
    withTelemetry('search_memory', async ({ query, limit, scope }) => {
      const ctx = await context();
      const results = await memory.recall(ctx, query, { limit, scope });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching memories.' }] };
      }
      const text = results
        .map((result) =>
          [
            `## ${result.title}`,
            `id: ${result.id}${result.project?.name ? ` · project: ${result.project.name}` : ''}`,
            '',
            result.content.trim(),
          ].join('\n'),
        )
        .join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    }),
  );

  server.registerTool(
    'save_memory',
    {
      title: 'Save memory',
      description:
        'Store a durable note in the memory vault, stamped with the current project. Duplicates are detected and skipped.',
      inputSchema: {
        title: z.string().describe('Specific, retrieval-friendly title. Maximum 200 characters.'),
        content: z
          .string()
          .describe(
            'Markdown body. Put the key fact in the first sentence. Maximum 8000 characters.',
          ),
        tags: z.array(z.string()).optional().describe('Optional tags. Maximum 6 tags.'),
        lifecycle: z.enum(['temporary', 'permanent']).optional(),
        role: z
          .enum(['summary', 'decision', 'plan', 'context', 'reference', 'research', 'review'])
          .optional()
          .describe(
            'Optional prioritization hint. Use "decision" for decisions, "reference" for durable specs, ' +
              '"context" for background, "plan" for plans, "research" for findings, "review" for review notes, ' +
              '"summary" for outcomes. If omitted, mnemonic infers a role from the note structure.',
          ),
      },
    },
    withTelemetry('save_memory', async ({ title, content, tags, lifecycle, role }) => {
      const validationError = validateMemoryInput({ title, content, tags });
      if (validationError) {
        return { content: [{ type: 'text' as const, text: validationError }], isError: true };
      }

      const ctx = await context();
      const result = await memory.save(ctx, { title, content, tags, lifecycle, role });
      const text = result.saved
        ? `Saved as ${result.id}.`
        : result.reason === 'duplicate'
          ? `Not saved: equivalent memory already exists.\n  id: ${result.id}\n  title: "${result.duplicateTitle}"\nUse update_memory to correct it, or search_memory to read it.`
          : `Not saved: ${result.reason ?? 'unknown error'}.`;
      return {
        content: [{ type: 'text' as const, text }],
        isError: !result.saved && result.reason === 'error',
      };
    }),
  );

  server.registerTool(
    'update_memory',
    {
      title: 'Update memory',
      description: 'Correct an existing memory in place. Prefer this over saving a near-duplicate.',
      inputSchema: {
        id: z.string(),
        title: z.string().optional().describe('Maximum 200 characters.'),
        content: z.string().optional().describe('Maximum 8000 characters.'),
        tags: z.array(z.string()).optional().describe('Maximum 6 tags.'),
      },
    },
    withTelemetry('update_memory', async ({ id, title, content, tags }) => {
      const validationError = validateMemoryInput({ title, content, tags });
      if (validationError) {
        return { content: [{ type: 'text' as const, text: validationError }], isError: true };
      }

      const ctx = await context();
      const ok = await memory.update(ctx, id, { title, content, tags });
      return {
        content: [
          { type: 'text' as const, text: ok ? `Updated ${id}.` : `Could not update ${id}.` },
        ],
        isError: !ok,
      };
    }),
  );

  server.registerTool(
    'forget_memory',
    {
      title: 'Forget memory',
      description: 'Delete a memory by id. Use when the user retracts something.',
      inputSchema: { id: z.string() },
    },
    withTelemetry('forget_memory', async ({ id }) => {
      const ctx = await context();
      const ok = await memory.forget(ctx, id);
      return {
        content: [
          { type: 'text' as const, text: ok ? `Forgot ${id}.` : `Could not forget ${id}.` },
        ],
        isError: !ok,
      };
    }),
  );

  server.registerTool(
    'list_memory',
    {
      title: 'List memory',
      description:
        'List notes in the vault with id, title, tags, lifecycle, and project. Use to see what exists without searching for specific terms.',
      inputSchema: {
        scope: z
          .enum(['project', 'global', 'all'])
          .optional()
          .describe(
            'Defaults to "all". Use "project" for only this project notes, "global" for unscoped.',
          ),
        tags: z.array(z.string()).optional().describe('Filter to notes with any of these tags.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum notes to return. Defaults to 50.'),
      },
    },
    withTelemetry('list_memory', async ({ scope, tags, limit }) => {
      const ctx = await context();
      const result = await memory.list(ctx, { scope, tags });
      const notes = Array.isArray(result)
        ? result
        : Array.isArray((result as { notes?: unknown[] })?.notes)
          ? (result as { notes: unknown[] }).notes
          : [];
      const limited = limit ? notes.slice(0, limit) : notes.slice(0, 50);
      if (limited.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const text = limited
        .map((note: Record<string, unknown>) => {
          const id = note.id ?? '';
          const title = note.title ?? '';
          const noteTags = Array.isArray(note.tags) ? note.tags.join(', ') : '';
          const lifecycle = note.lifecycle ?? '';
          const project = note.projectName ?? '';
          const role = note.role ?? '';
          return [
            `- **${title}**`,
            `  id: \`${id}\``,
            project ? `  project: ${project}` : '',
            role ? `  role: ${role}` : '',
            noteTags ? `  tags: ${noteTags}` : '',
            lifecycle ? `  lifecycle: ${lifecycle}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n\n');
      return { content: [{ type: 'text' as const, text }] };
    }),
  );

  server.registerTool(
    'memory_status',
    {
      title: 'Memory status',
      description:
        'Report whether automatic memory is on for this chat and which project it is scoped to.',
      inputSchema: {},
    },
    withTelemetry('memory_status', async () => {
      const ctx = await context();
      const setting = await store.getMemorySetting(userId, conversationId);
      const projectLine = ctx.projectName
        ? `Project: **${ctx.projectName}**`
        : 'Project: _none_ (MCP tool calls may not resolve project context outside chat turns; the automatic path works correctly during chat)';
      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Automatic memory: ${setting.enabled ? 'on' : 'off'} (${setting.source})`,
              projectLine,
              `Write scope: ${config.mnemonic.writeScope}, recall scope: ${config.mnemonic.recallScope}`,
            ].join('\n'),
          },
        ],
      };
    }),
  );

  server.registerTool(
    'set_memory_enabled',
    {
      title: 'Enable or disable memory for this chat',
      description:
        'Turn automatic recall and saving on or off for the current conversation only. Call when the user asks you to stop or start remembering here.',
      inputSchema: { enabled: z.boolean() },
    },
    withTelemetry('set_memory_enabled', async ({ enabled }) => {
      if (!conversationId) {
        return {
          content: [{ type: 'text' as const, text: 'No conversation id available.' }],
          isError: true,
        };
      }
      await store.setConversationMemory(conversationId, userId, enabled);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Automatic memory is now ${enabled ? 'on' : 'off'} for this chat.`,
          },
        ],
      };
    }),
  );

  return server;
}

export function createMcpHandler(deps: McpDeps) {
  return async function handle(req: Request, res: Response): Promise<void> {
    const userHeader = req.headers[deps.config.librechat.userHeader];
    const conversationHeader = req.headers[deps.config.librechat.conversationHeader];
    const userId = firstHeader(userHeader);
    const conversationId = firstHeader(conversationHeader);
    const server = buildServer(deps, userId, conversationId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      const body = Buffer.isBuffer(req.body) ? safeJson(req.body) : req.body;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error({ err: error }, 'mcp request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };
}

/**
 * The readable half of a tool result. Langfuse renders a plain string far
 * better than the `{ content: [{ type, text }] }` envelope, so collapse text
 * parts and fall back to the whole result for anything unexpected.
 */
function toolOutput(result: ToolResult): unknown {
  if (!Array.isArray(result.content)) return result;
  const texts = result.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .filter((text) => typeof text === 'string');
  return texts.length > 0 ? texts.join('\n') : result;
}

function validateMemoryInput(input: {
  title?: string;
  content?: string;
  tags?: string[];
}): string | null {
  if (input.title != null && input.title.length > 200) {
    return `title exceeds 200 character limit (got ${input.title.length}). Shorten the title.`;
  }
  if (input.content != null && input.content.length > 8000) {
    return `content exceeds 8000 character limit (got ${input.content.length}). Split the note or trim content.`;
  }
  if (input.tags != null && input.tags.length > 6) {
    return `tags exceeds maximum of 6 (got ${input.tags.length}). Remove some tags.`;
  }
  return null;
}

function firstHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed ? trimmed : null;
}

function safeJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return undefined;
  }
}
