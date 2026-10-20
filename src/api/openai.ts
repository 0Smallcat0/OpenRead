/**
 * Client for any OpenAI-compatible chat-completions API, with the user's key.
 *
 * The one engine that sends text off the machine, and it does so only when the
 * user chooses it. It exists for the reader the other two cannot serve: a
 * language pair Chrome has no pack for, on a computer that cannot run a model
 * worth reading. One protocol covers OpenAI, DeepSeek, OpenRouter, Groq,
 * Gemini's compatibility endpoint and LM Studio, so one client does.
 *
 * Streaming is server-sent events: `data: {json}` lines, ending `data: [DONE]`.
 * `extractSseChunk` parses one line and is pure, so the parser is testable
 * without a socket — the same split `ollama.ts` uses for NDJSON.
 *
 * The prompt is the one the Ollama path ships, so the two engines translate
 * from the same instructions; this file owns only the network I/O and the
 * failures a pasted key meets.
 */
import { TraditionalTWTransform } from '../core/zh-convert';
import { StreamAssembler } from '../core/stream';
import type { TranslationContext } from '../core/types';
import {
  buildMessages,
  wantsTraditional,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './ollama';
import { apiHeaders, normalizeApiBase } from './probe';

export interface SseChunk {
  /** Assistant-content delta; '' for role-only and reasoning-only events. */
  content: string;
  done: boolean;
  /** An error the provider sent inside the stream, after a 200. */
  error?: string;
}

/**
 * Parse one line of a chat-completions event stream.
 *
 * Null for anything that is not a `data:` line — blank keep-alives, `:`
 * comments, `event:` names — and for payloads that do not parse. Reasoning
 * deltas (`reasoning_content`, `reasoning`) are dropped on purpose: they are
 * the model thinking aloud, and the reader asked for a translation.
 */
export function extractSseChunk(line: string): SseChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '[DONE]') return { content: '', done: true };
  try {
    const json = JSON.parse(payload) as {
      choices?: { delta?: { content?: unknown } }[];
      error?: { message?: unknown } | string;
    };
    if (typeof json !== 'object' || json === null) return null;
    // OpenRouter reports a provider failing mid-answer this way: the status
    // line already said 200, so the body is the only place left to say it.
    if (json.error) {
      const message =
        typeof json.error === 'string'
          ? json.error
          : typeof json.error.message === 'string'
            ? json.error.message
            : 'the provider reported an error';
      return { content: '', done: true, error: message };
    }
    const content = json.choices?.[0]?.delta?.content;
    return { content: typeof content === 'string' ? content : '', done: false };
  } catch {
    return null;
  }
}

/** The provider's own words from an error body, or ''. */
function providerMessage(data: unknown): string {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === 'string') return error;
  const nested = (error as { message?: unknown } | null)?.message;
  if (typeof nested === 'string') return nested;
  // Some servers answer with a bare array of errors, one per field.
  if (Array.isArray(data)) return providerMessage(data[0]);
  return '';
}

/**
 * The sentence a reader sees for a failed request.
 *
 * Pure, and exported for the tests. Each branch names the setting that fixes
 * it, because the failures a pasted key meets are all fixed in the popup.
 */
export function describeApiError(
  status: number,
  message: string,
  host: string,
  hasKey: boolean,
): string {
  const said = message.trim() ? `: ${message.trim()}` : '';
  switch (status) {
    case 401:
      return hasKey
        ? `${host} rejected the API key (401). Check the key in OpenRead's settings.`
        : `${host} needs an API key. Paste one in OpenRead's settings.`;
    case 403:
      return `${host} refused the request (403)${said}`;
    case 404:
      return (
        `${host} answered 404${said}. Check the model name, and that the ` +
        'address ends at the version, like …/v1.'
      );
    case 429:
      return (
        `${host} is limiting this key (429)${said}. Wait a moment, or check ` +
        'the account has credit.'
      );
    default:
      return `${host} answered ${String(status)}${said}`;
  }
}

/** `api.openai.com`, for messages; the raw string when it is not a URL. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * How long a rate-limited request is willing to wait before trying again.
 *
 * Longer than this and the reader is better told: a free-tier key that asks
 * for a minute's pause is out of requests for the page, not briefly busy.
 */
export const MAX_RETRY_WAIT_MS = 20_000;
/** Retries after a 429 or 503, each after the wait the server asked for. */
export const MAX_RATE_RETRIES = 3;

/**
 * The pause a 429 or 503 asked for, or a doubling guess when it did not say.
 *
 * Whole-page translation keeps two requests in flight, which a free-tier key
 * can exceed in seconds; without honouring the pause, the rest of the page
 * fails one block at a time.
 */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  now = Date.now(),
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return 1000 * 2 ** attempt;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reject if `work` has not settled in `ms`. A timer rather than an abort, for
 * the reason `ollama.ts` gives: an abort reads as the user cancelling, and the
 * broker swallows those silently.
 */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  host: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `${host} sent nothing for ${String(Math.round(ms / 1000))}s. ` +
            'The provider may be overloaded — try again.',
        ),
      );
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

export interface OpenAIStreamParams {
  text: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  targetLang: string;
  context?: TranslationContext;
  /** 0 = first attempt (temp 0.3); >0 = retry (temp 0.7), as on Ollama. */
  retryCount?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onChunk: (chunk: string) => void;
}

/** Stream a translation, invoking `onChunk` with cleaned, render-ready text. */
export async function translateStreamOpenAI(
  params: OpenAIStreamParams,
): Promise<void> {
  const { text, apiKey, targetLang, context, signal, onChunk } = params;
  const retryCount = params.retryCount ?? 0;
  const timeoutMs = params.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!text) return;
  const base = normalizeApiBase(params.baseUrl);
  if (!base) throw new Error("Enter the API's address in OpenRead's settings.");
  const model = params.model.trim();
  if (!model)
    throw new Error("Choose a model for the API in OpenRead's settings.");
  const host = hostOf(base);

  const messages = buildMessages(text, targetLang, context);
  // Reasoning models (OpenAI's o-series and GPT-5, among others) reject any
  // temperature but their default with a 400 that names the parameter. The
  // request is made again without it rather than failing a model the user
  // chose deliberately.
  let sendTemperature = true;
  let rateRetries = 0;
  let response: Response;
  for (;;) {
    const body: Record<string, unknown> = { model, messages, stream: true };
    if (sendTemperature) body.temperature = retryCount > 0 ? 0.7 : 0.3;
    response = await withTimeout(
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal,
        headers: apiHeaders(apiKey),
        body: JSON.stringify(body),
      }),
      timeoutMs,
      host,
    );
    if (response.ok) break;

    const data: unknown = await response.json().catch(() => null);
    const said = providerMessage(data);
    if (
      response.status === 400 &&
      sendTemperature &&
      /temperature/i.test(said)
    ) {
      sendTemperature = false;
      continue;
    }
    if (
      (response.status === 429 || response.status === 503) &&
      rateRetries < MAX_RATE_RETRIES
    ) {
      const wait = retryDelayMs(
        response.headers.get('retry-after'),
        rateRetries,
      );
      if (wait <= MAX_RETRY_WAIT_MS) {
        rateRetries += 1;
        await sleep(wait, signal);
        continue;
      }
    }
    throw new Error(
      describeApiError(response.status, said, host, apiKey.trim() !== ''),
    );
  }
  if (!response.body) throw new Error(`${host} returned no response body`);

  const assembler = new StreamAssembler({
    source: text,
    transform: wantsTraditional(targetLang)
      ? new TraditionalTWTransform()
      : undefined,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let lineBuffer = '';

  try {
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), timeoutMs, host);
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      let finished = false;
      for (const line of lines) {
        const chunk = extractSseChunk(line);
        if (chunk === null) continue;
        if (chunk.error) throw new Error(`${host}: ${chunk.error}`);
        if (chunk.done) {
          finished = true;
          break;
        }
        if (chunk.content === '') continue;
        const emit = assembler.push(chunk.content);
        if (emit) onChunk(emit);
      }
      if (finished) break;
    }
    const tail = assembler.end();
    if (tail) onChunk(tail);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
