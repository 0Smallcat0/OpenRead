/**
 * Ollama chat-completions client. Ollama exposes an OpenAI-compatible endpoint
 * (`/v1/chat/completions`) with identical SSE streaming, so the streaming
 * machinery here is standard — the only Ollama specifics are the local base URL
 * and the absence of any auth header (inference runs on the user's machine).
 *
 * Two entry points:
 *   - translateStream: SSE streaming for the interactive path.
 *   - translateText:   single non-streamed call, used for retry fallbacks.
 *
 * All prompt building and output cleanup lives in the pure `core` modules; this
 * file only owns the network I/O. Cancellation is per-request via an injected
 * AbortSignal — no shared mutable controller, so concurrent callers never race.
 */
import { generateSystemPrompt, getFewShotMessages } from '../core/prompt';
import { cleanTranslationOutput } from '../core/sanitize';
import { toTraditionalTW } from '../core/zh-convert';
import { StreamAssembler } from '../core/stream';
import type { ChatMessage, TranslationContext } from '../core/types';

/** Build the OpenAI-compatible chat endpoint for an Ollama server base URL. */
function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
}

function wantsTraditional(targetLang: string): boolean {
  return (
    targetLang.includes('Traditional') ||
    targetLang.includes('繁體') ||
    targetLang.includes('Taiwan')
  );
}

function buildUserContent(text: string, context?: TranslationContext): string {
  if (!context) return text;
  return (
    `<context_before>\n${context.contextBefore ?? ''}\n</context_before>\n` +
    `<target>\n${text}\n</target>\n` +
    `<context_after>\n${context.contextAfter ?? ''}\n</context_after>\n` +
    'Instruction: Translate only the text inside <target>.'
  );
}

function buildMessages(
  text: string,
  targetLang: string,
  context?: TranslationContext,
): ChatMessage[] {
  return [
    { role: 'system', content: generateSystemPrompt(targetLang) },
    ...getFewShotMessages(targetLang),
    { role: 'user', content: buildUserContent(text, context) },
  ];
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const data: unknown = await response.json().catch(() => ({}));
  const message =
    (data as { error?: { message?: string } })?.error?.message ??
    JSON.stringify(data);
  throw new Error(`Ollama ${response.status}: ${message}`);
}

/**
 * Parse one SSE line into its delta content. Returns null for keep-alives,
 * the `[DONE]` sentinel, non-`data:` lines, and unparseable payloads. Pure, so
 * the stream parser is unit-testable without a socket.
 */
export function extractDelta(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '' || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return json.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

export interface StreamParams {
  text: string;
  baseUrl: string;
  model: string;
  targetLang: string;
  context?: TranslationContext;
  /** 0 = first attempt (precise, temp 0.3); >0 = retry (looser, temp 0.7). */
  retryCount?: number;
  signal?: AbortSignal;
  onChunk: (chunk: string) => void;
}

/** Stream a translation, invoking `onChunk` with cleaned, render-ready text. */
export async function translateStream(params: StreamParams): Promise<void> {
  const { text, baseUrl, model, targetLang, context, signal, onChunk } = params;
  const retryCount = params.retryCount ?? 0;
  if (!text) return;
  if (!baseUrl) throw new Error('Ollama server URL is missing');

  const response = await fetch(endpoint(baseUrl), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: buildMessages(text, targetLang, context),
      temperature: retryCount > 0 ? 0.7 : 0.3,
      stream: true,
    }),
  });
  await assertOk(response);
  if (!response.body) throw new Error('Ollama returned no response body');

  const assembler = new StreamAssembler({
    transform: wantsTraditional(targetLang) ? toTraditionalTW : undefined,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let lineBuffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const delta = extractDelta(line);
        if (delta === null) continue;
        const emit = assembler.push(delta);
        if (emit) onChunk(emit);
      }
    }
    const tail = assembler.end();
    if (tail) onChunk(tail);
  } finally {
    reader.releaseLock();
  }
}

export interface TranslateParams {
  text: string;
  baseUrl: string;
  model: string;
  targetLang: string;
  context?: TranslationContext;
  signal?: AbortSignal;
}

/** Single non-streamed translation. Used as the sequential retry fallback. */
export async function translateText(params: TranslateParams): Promise<string> {
  const { text, baseUrl, model, targetLang, context, signal } = params;
  if (!text) return '';
  if (!baseUrl) throw new Error('Ollama server URL is missing');

  const response = await fetch(endpoint(baseUrl), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: buildMessages(text, targetLang, context),
      temperature: 0.3,
    }),
  });
  await assertOk(response);

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Ollama returned an empty message');

  const cleaned = cleanTranslationOutput(text, content);
  return wantsTraditional(targetLang) ? toTraditionalTW(cleaned) : cleaned;
}
