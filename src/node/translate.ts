/**
 * The translation pipeline, outside the browser.
 *
 * Everything valuable in this project — the artifact filters, the streaming
 * assembler, the Taiwan-convention conversion, the prompt that was chosen by
 * benchmark — lived behind a Chrome extension, reachable only by a person
 * clicking. A script could not use it. Neither could an agent. That is a
 * strange place to keep a text-in / text-out function.
 *
 * This is not a reimplementation. It calls `translateStream` from
 * `api/ollama.ts`: the same request, the same `think: false`, the same
 * `StreamAssembler`, the same OpenCC transform the extension ships. The core
 * was written framework-free so that this file could be twenty lines, and it
 * is. If the CLI and the extension ever disagree, that is a bug, not a
 * difference in kind.
 */
import { translateStream } from '../api/ollama';
import type { TranslationContext } from '../core/types';

export interface TranslateOptions {
  text: string;
  targetLang: string;
  model: string;
  baseUrl: string;
  context?: TranslationContext;
  signal?: AbortSignal;
  /** Called with each cleaned delta, for callers that want to stream. */
  onChunk?: (chunk: string) => void;
}

/** Translate one string and resolve with the finished, cleaned text. */
export async function translate({
  text,
  targetLang,
  model,
  baseUrl,
  context,
  signal,
  onChunk,
}: TranslateOptions): Promise<string> {
  let full = '';
  await translateStream({
    text,
    targetLang,
    model,
    baseUrl,
    context,
    signal,
    onChunk: (chunk) => {
      full += chunk;
      onChunk?.(chunk);
    },
  });
  return full;
}

export interface OllamaModel {
  name: string;
}

/**
 * List the models the server has, so a caller can fail with "you have these"
 * rather than with a 404 from the middle of a generation.
 */
export async function listModels(baseUrl: string): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama answered ${String(response.status)} at ${baseUrl}`);
  }
  const data = (await response.json()) as { models?: OllamaModel[] };
  return (data.models ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string');
}
