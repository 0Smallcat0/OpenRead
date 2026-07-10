/**
 * Ollama chat client, on the native `/api/chat` endpoint.
 *
 * Native rather than the OpenAI-compat `/v1` endpoint for one hard reason,
 * found by the benchmark harness: on reasoning models (qwen3 family,
 * deepseek-r1) the compat endpoint routes chain-of-thought into a separate
 * `reasoning` field and — with thinking enabled by default — can burn the
 * entire generation thinking while `content` stays empty, so the extension
 * rendered nothing. The native endpoint accepts `think: false` (honoured by
 * hybrid thinkers, tolerated as a no-op by non-thinkers, and by models that
 * cannot stop thinking — e.g. deepseek-r1 — it still keeps the thinking out
 * of `content`). Requires Ollama ≥ 0.9.
 *
 * Streaming is NDJSON: one JSON object per line, `done: true` on the final
 * chunk (which also carries token counts). `extractChunk` parses one line and
 * is pure, so the stream parser is unit-testable without a socket.
 *
 * All prompt building and output cleanup lives in the pure `core` modules;
 * this file only owns the network I/O. Cancellation is per-request via an
 * injected AbortSignal — no shared mutable controller, so concurrent callers
 * never race.
 */
import { generateSystemPrompt, getFewShotMessages } from '../core/prompt';
import { cleanTranslationOutput } from '../core/sanitize';
import { toTraditionalTW } from '../core/zh-convert';
import { StreamAssembler } from '../core/stream';
import {
  buildEnrichMessages,
  parseEnrichResponse,
  ENRICH_SCHEMA,
} from '../core/enrich';
import type {
  ChatMessage,
  TranslationContext,
  EnrichResult,
} from '../core/types';

/** Build the native chat endpoint for an Ollama server base URL. */
function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/chat`;
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

/** Exported so the benchmark harness scores the exact shipped prompt. */
export function buildMessages(
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
  const error = (data as { error?: string | { message?: string } })?.error;
  const message =
    typeof error === 'string'
      ? error
      : (error?.message ?? JSON.stringify(data));
  throw new Error(`Ollama ${response.status}: ${message}`);
}

export interface NativeChunk {
  /** Assistant-content delta in this chunk; '' for thinking-only chunks. */
  content: string;
  /** Chain-of-thought delta, kept separate so it never reaches the UI. */
  thinking: string;
  done: boolean;
  /** Generated-token count, present on the `done: true` chunk. */
  evalCount?: number;
}

/**
 * Parse one NDJSON stream line from `/api/chat`. Returns null for blank lines
 * and unparseable payloads. Pure, so the stream parser is unit-testable.
 */
export function extractChunk(line: string): NativeChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const json = JSON.parse(trimmed) as {
      message?: { content?: string; thinking?: string };
      done?: boolean;
      eval_count?: number;
    };
    if (typeof json !== 'object' || json === null) return null;
    return {
      content: json.message?.content ?? '',
      thinking: json.message?.thinking ?? '',
      done: json.done === true,
      evalCount: json.eval_count,
    };
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
      stream: true,
      think: false,
      options: { temperature: retryCount > 0 ? 0.7 : 0.3 },
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
        const chunk = extractChunk(line);
        if (chunk === null || chunk.content === '') continue;
        const emit = assembler.push(chunk.content);
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
      stream: false,
      think: false,
      options: { temperature: 0.3 },
    }),
  });
  await assertOk(response);

  const data = (await response.json()) as {
    message?: { content?: string };
  };
  const content = data.message?.content;
  if (!content) throw new Error('Ollama returned an empty message');

  const cleaned = cleanTranslationOutput(text, content);
  return wantsTraditional(targetLang) ? toTraditionalTW(cleaned) : cleaned;
}

export interface EnrichParams {
  text: string;
  baseUrl: string;
  model: string;
  targetLang: string;
  signal?: AbortSignal;
}

/**
 * Single non-streamed enrichment call: ask a small model to label a capture
 * with a title, summary, and tags. Best-effort by design — returns null on any
 * HTTP or parse failure so a weak local model can never block a capture.
 * Temperature 0 for determinism.
 */
export async function enrichText(
  params: EnrichParams,
): Promise<EnrichResult | null> {
  const { text, baseUrl, model, targetLang, signal } = params;
  if (!text || !baseUrl) return null;

  const response = await fetch(endpoint(baseUrl), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: buildEnrichMessages(text, targetLang),
      stream: false,
      think: false,
      format: ENRICH_SCHEMA,
      options: { temperature: 0 },
    }),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    message?: { content?: string };
  };
  return parseEnrichResponse(data.message?.content ?? '');
}
