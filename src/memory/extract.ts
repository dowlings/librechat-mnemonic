import type { AppConfig } from '../config.js';
import { logger } from '../logger.js';
import type { MemoryCandidate } from './types.js';
import { sanitizeTitle } from './sanitize.js';

/**
 * Deciding what is worth remembering.
 *
 * Two modes:
 *
 * - `explicit` costs nothing and only fires when the user actually asks. Use
 *   it if you distrust automatic extraction or want to keep the vault clean.
 * - `llm` asks a small model, once per turn, out of band. It never blocks the
 *   user's response; a failure here is logged and dropped.
 */

const EXPLICIT_PATTERNS: RegExp[] = [
  /^\s*(?:please\s+)?remember(?:\s+that)?[:,\s]+(.+)/is,
  /^\s*note to self[:,\s]+(.+)/is,
  /^\s*make a note(?:\s+that)?[:,\s]+(.+)/is,
  /^\s*(?:don'?t|do not) forget(?:\s+that)?[:,\s]+(.+)/is,
];

export function extractExplicit(userMessage: string): MemoryCandidate[] {
  for (const pattern of EXPLICIT_PATTERNS) {
    const match = pattern.exec(userMessage);
    const body = match?.[1]?.trim();
    if (body) {
      return [{ title: deriveTitle(body), content: body, lifecycle: 'permanent', role: 'context' }];
    }
  }
  return [];
}

export interface ModelSpec {
  api: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
}

const SYSTEM_PROMPT = `You extract durable memories from a conversation for a long-term knowledge vault.
Return JSON only, in this exact shape:
{"memories":[{"title":"...","content":"...","tags":["..."],"lifecycle":"permanent","role":"context"}]}
Store a memory only when it is worth recalling weeks from now:
- decisions and the reasoning behind them
- stable facts about the user, their systems, their environment or their preferences
- solutions to problems, and things that were ruled out and why
- commitments, deadlines and named entities that will come up again
Do not store:
- anything already obvious from the question itself
- transient state, small talk, or the assistant's own reasoning
- speculation, or anything the user has not confirmed
- credentials, tokens, API keys, or other secrets
Write each memory so it stands alone without the surrounding conversation.
Put the key fact in the opening sentence. Use plain markdown, no headings.
Titles are specific and retrieval-friendly, at most 100 characters.
Use "temporary" lifecycle for in-flight work, "permanent" for durable knowledge.
Set "role" to one of: summary, decision, plan, context, reference, research, review.
Use "context" for background facts, "decision" for decisions, "reference" for durable specs,
"summary" for outcomes, "plan" for plans, "research" for findings, "review" for review notes.
Return {"memories":[]} when nothing meets the bar. That is the common case; be strict.`;

export async function extractWithModel(
  spec: ModelSpec,
  exchange: { user: string; assistant: string; project?: string | null },
  config: AppConfig,
): Promise<MemoryCandidate[]> {
  const userPrompt = [
    exchange.project ? `Project: ${exchange.project}` : 'Project: (none)',
    '',
    '<user_message>',
    truncate(exchange.user, 6000),
    '</user_message>',
    '',
    '<assistant_reply>',
    truncate(exchange.assistant, 6000),
    '</assistant_reply>',
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.extract.timeoutMs);
  try {
    const raw = await callModel(spec, SYSTEM_PROMPT, userPrompt, controller.signal);
    return parseCandidates(raw, config.memory.maxPerTurn);
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warn('memory extraction timed out');
    } else {
      logger.error({ err: error }, 'memory extraction failed');
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(
  spec: ModelSpec,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  if (spec.api === 'anthropic') {
    const response = await fetch(`${trimSlash(spec.baseUrl)}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...spec.headers,
      },
      body: JSON.stringify({
        model: spec.model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!response.ok) {
      throw new Error(`extraction model returned ${response.status}: ${await safeText(response)}`);
    }
    const json = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    return (json.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }
  const response = await fetch(`${trimSlash(spec.baseUrl)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...spec.headers },
    body: JSON.stringify({
      model: spec.model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`extraction model returned ${response.status}: ${await safeText(response)}`);
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}

/** Models wrap JSON in prose and fences often enough that this has to be tolerant. */
export function parseCandidates(raw: string, max: number): MemoryCandidate[] {
  const text = raw.trim();
  if (!text) return [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1]?.trim() ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  const memories = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(memories)) return [];
  const VALID_ROLES = ['summary', 'decision', 'plan', 'context', 'reference', 'research', 'review'];
  const out: MemoryCandidate[] = [];
  for (const entry of memories) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === 'string' ? sanitizeTitle(record.title) : '';
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (!title || !content) continue;
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [];
    const lifecycle = record.lifecycle === 'temporary' ? 'temporary' : 'permanent';
    const role =
      typeof record.role === 'string' && VALID_ROLES.includes(record.role)
        ? record.role
        : 'context';
    out.push({
      title: title.slice(0, 120),
      content: content.slice(0, 8000),
      tags: tags.slice(0, 6).map((tag) => tag.trim()),
      lifecycle,
      role,
    });
    if (out.length >= max) break;
  }
  return out;
}

function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const clean = sanitizeTitle(firstLine);
  const clipped = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
  return clipped || 'Untitled memory';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return '';
  }
}
