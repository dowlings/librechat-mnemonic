import type { AppConfig } from '../config.js';
import type { LibreChatStore } from '../librechat/mongo.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryContext } from '../memory/types.js';
import { sanitizeTitle } from '../memory/sanitize.js';
/**
 * In-chat control surface.
 *
 * LibreChat has no place to hang a per-conversation setting for a third-party
 * service, so the toggle lives in the message stream: the proxy intercepts a
 * command, acts on it, and answers with a synthetic assistant turn. The model
 * is never called. This works on every endpoint routed through the proxy and
 * needs no changes to LibreChat.
 */
export interface CommandResult {
  /** Markdown returned to the user as the assistant's reply. */
  reply: string;
}
export function parseCommand(
  text: string,
  prefix: string,
): { name: string; rest: string } | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const remainder = trimmed.slice(prefix.length);
  // Require a word break so "/memoryfoo" is not treated as a command.
  if (remainder && !/^[\s]/.test(remainder)) return null;
  const [name = '', ...words] = remainder.trim().split(/\s+/);
  return { name: name.toLowerCase(), rest: words.join(' ').trim() };
}
export async function runCommand(
  command: { name: string; rest: string },
  context: MemoryContext,
  deps: { config: AppConfig; store: LibreChatStore; memory: MemoryService },
): Promise<CommandResult> {
  const { config, store, memory } = deps;
  const prefix = config.memory.commandPrefix;
  switch (command.name) {
    case '':
    case 'help':
      return {
        reply: [
          '**Memory commands**',
          '',
          `- \`${prefix} on\` / \`${prefix} off\`: enable or disable memory for this chat`,
          `- \`${prefix} status\`: show the current setting and project`,
          `- \`${prefix} default on|off\`: set your personal default for new chats`,
          `- \`${prefix} reset\`: clear this chat's override and follow your default`,
          `- \`${prefix} save <text>\`: store a memory now`,
          `- \`${prefix} search <query>\`: search memory without asking the model`,
          `- \`${prefix} list\`: list recent memories`,
          `- \`${prefix} forget <id>\`: delete a memory by id`,
        ].join('\n'),
      };
    case 'on':
    case 'off': {
      if (!context.conversationId) {
        return { reply: 'No conversation id was supplied, so this chat cannot be toggled.' };
      }
      const enabled = command.name === 'on';
      await store.setConversationMemory(context.conversationId, context.userId, enabled);
      return {
        reply: enabled
          ? `Memory is **on** for this chat${context.projectName ? ` (project: ${context.projectName})` : ''}.`
          : 'Memory is **off** for this chat. Nothing will be recalled or saved here.',
      };
    }
    case 'reset': {
      if (!context.conversationId) return { reply: 'No conversation id was supplied.' };
      await store.clearConversationMemory(context.conversationId);
      const setting = await store.getMemorySetting(context.userId, context.conversationId);
      return {
        reply: `Override cleared. This chat now follows your default: memory is **${
          setting.enabled ? 'on' : 'off'
        }**.`,
      };
    }
    case 'default': {
      if (!context.userId) return { reply: 'No user id was supplied, so no default can be saved.' };
      const value = command.rest.toLowerCase();
      if (value !== 'on' && value !== 'off') {
        return { reply: `Usage: \`${prefix} default on\` or \`${prefix} default off\`.` };
      }
      await store.setUserDefaultMemory(context.userId, value === 'on');
      return { reply: `Your default for new chats is now **${value}**.` };
    }
    case 'status': {
      const setting = await store.getMemorySetting(context.userId, context.conversationId);
      const sourceLabel = {
        conversation: 'set for this chat',
        user: 'your personal default',
        default: 'the server default',
      }[setting.source];
      return {
        reply: [
          `Memory is **${setting.enabled ? 'on' : 'off'}** (${sourceLabel}).`,
          `Project: ${context.projectName ? `**${context.projectName}**` : '_none, this chat is not in a project_'}`,
          `Write scope: \`${config.mnemonic.writeScope}\` · recall scope: \`${config.mnemonic.recallScope}\` · write mode: \`${config.memory.writeMode}\``,
        ].join('\n'),
      };
    }
    case 'save': {
      if (!command.rest) return { reply: `Usage: \`${prefix} save <what to remember>\`` };
      const title = deriveTitle(command.rest);
      const result = await memory.save(context, {
        title,
        content: command.rest,
        lifecycle: 'permanent',
        role: 'context',
      });
      if (result.saved) {
        return { reply: `Saved as \`${result.id}\`${context.projectName ? ` under **${context.projectName}**` : ''}.` };
      }
      if (result.reason === 'duplicate') {
        return { reply: `Already known, see \`${result.id}\`${result.duplicateTitle ? ` (${result.duplicateTitle})` : ''}. Nothing new was stored.` };
      }
      return { reply: `Could not save that memory (${result.reason ?? 'unknown error'}).` };
    }
    case 'search': {
      if (!command.rest) return { reply: `Usage: \`${prefix} search <query>\`` };
      const results = await memory.recall(context, command.rest, { limit: 5 });
      if (results.length === 0) return { reply: 'No matching memories.' };
      return {
        reply: [
          `**${results.length} match${results.length === 1 ? '' : 'es'}**`,
          '',
          ...results.map((result) => {
            const snippet = (result.content || '').trim().slice(0, 200);
            const lines = [
              `- **${result.title}** \`${result.id}\`${
                result.project?.name ? ` · ${result.project.name}` : ''
              }`,
            ];
            if (snippet) lines.push(`  > ${snippet}${result.content.length > 200 ? '…' : ''}`);
            return lines.join('\n');
          }),
        ].join('\n'),
      };
    }
    case 'list': {
      const result = await memory.list(context, { scope: 'all' });
      const notes = Array.isArray(result)
        ? result
        : Array.isArray((result as { notes?: unknown[] })?.notes)
          ? (result as { notes: unknown[] }).notes
          : [];
      const limited = notes.slice(0, 20);
      if (limited.length === 0) return { reply: 'No memories found.' };
      return {
        reply: [
          `**${limited.length} memor${limited.length === 1 ? 'y' : 'ies'}**${notes.length > 20 ? ` (showing 20 of ${notes.length})` : ''}`,
          '',
          ...limited.map((note: Record<string, unknown>) => {
            const id = note.id ?? '';
            const title = note.title ?? '';
            const project = note.projectName ? ` · ${note.projectName}` : '';
            const tags = Array.isArray(note.tags) && note.tags.length > 0 ? ` · ${note.tags.join(', ')}` : '';
            return `- **${title}** \`${id}\`${project}${tags}`;
          }),
        ].join('\n'),
      };
    }
    case 'forget': {
      if (!command.rest) return { reply: `Usage: \`${prefix} forget <memory id>\`` };
      const ok = await memory.forget(context, command.rest);
      return { reply: ok ? `Forgot \`${command.rest}\`.` : `Could not forget \`${command.rest}\`.` };
    }
    default:
      return {
        reply: `Unknown command \`${command.name}\`. Try \`${prefix} help\`.`,
      };
  }
}
function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? text.trim();
  const clean = sanitizeTitle(firstLine);
  const clipped = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
  return clipped || 'Untitled memory';
}