/**
 * Chrome's built-in, on-device translator.
 *
 * This is the default engine, and the reason the extension works the moment it
 * is installed. Chrome ships a dedicated translation model and downloads the
 * language pack itself on first use — a one-time wait measured at 131 s here,
 * with no server to install and no multi-gigabyte model to pull. After that a
 * sentence comes back in 9–20 ms, against roughly 2,000 ms for a local 8B LLM.
 *
 * Quality is not the trade it looks like. Measured against the same sentences
 * the Ollama path was benchmarked on, it produced `使用者介面`,
 * `資料庫連線字串` and `本地電腦上運行大型語言模型` — the Taiwan conventions
 * that the OpenCC `s2twp` layer exists to produce, arrived at natively because
 * `zh-Hant` is a first-class target rather than a post-processing step.
 *
 * What it does not do is the reason Ollama stays: no surrounding-page context,
 * no choice of model, no prompt to steer, and nothing to build the capture
 * enrichment on. It is a translator, not a language model.
 *
 * Runs in the background service worker, next to the Ollama broker, so the
 * content script's port protocol is identical for both engines and neither the
 * selection UI nor whole-page translation knows which one answered.
 */
import { toBcp47 } from '../core/bcp47';

/**
 * Minimal ambient shapes for the Translator and LanguageDetector APIs.
 *
 * Hand-written because `@types/chrome` does not cover them and `lib.dom` has
 * not caught up. Only the members this file calls are declared — a fuller
 * guess would be a fuller opportunity to be wrong.
 */
interface DownloadMonitor {
  addEventListener: (
    type: 'downloadprogress',
    listener: (event: { loaded: number }) => void,
  ) => void;
}

interface TranslatorInstance {
  translate: (input: string) => Promise<string>;
  translateStreaming?: (input: string) => ReadableStream<string>;
  destroy?: () => void;
}

interface TranslatorFactory {
  availability: (options: {
    sourceLanguage: string;
    targetLanguage: string;
  }) => Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create: (options: {
    sourceLanguage: string;
    targetLanguage: string;
    signal?: AbortSignal;
    monitor?: (monitor: DownloadMonitor) => void;
  }) => Promise<TranslatorInstance>;
}

interface DetectorInstance {
  detect: (
    input: string,
  ) => Promise<{ detectedLanguage: string; confidence: number }[]>;
  destroy?: () => void;
}

interface DetectorFactory {
  availability: () => Promise<string>;
  create: (options?: {
    signal?: AbortSignal;
    monitor?: (monitor: DownloadMonitor) => void;
  }) => Promise<DetectorInstance>;
}

// `globalThis`, not `self`. Both name the service worker's global scope, but
// only one of them exists in Node, and these functions are worth being able to
// unit-test outside a browser.
function factory(): TranslatorFactory | null {
  const global = globalThis as unknown as { Translator?: TranslatorFactory };
  return global.Translator ?? null;
}

function detectorFactory(): DetectorFactory | null {
  const global = globalThis as unknown as {
    LanguageDetector?: DetectorFactory;
  };
  return global.LanguageDetector ?? null;
}

/**
 * `<html lang>` is author-written and often sloppy: "EN", "en_US", or empty.
 * Normalise what is salvageable and discard what is not, rather than handing
 * `Translator.create` a string it will reject.
 */
function normaliseLang(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/_/g, '-');
  if (!trimmed) return null;
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed)) return null;
  const [primary, ...rest] = trimmed.split('-');
  if (!primary) return null;
  return [primary.toLowerCase(), ...rest].join('-');
}

/** `zh-Hant` and `zh-TW` are the same language for "is this a translation?". */
function baseLanguage(code: string): string {
  return code.split('-')[0]?.toLowerCase() ?? code;
}

/** Whether this browser exposes the API at all. Chrome 138+; not Firefox. */
export function isBuiltinSupported(): boolean {
  return factory() !== null;
}

/**
 * Detect the language of `text`, or null when detection is unavailable or
 * unsure.
 *
 * Null matters: `Translator.create` needs a source language, and a wrong guess
 * translates from a language the text is not in, which produces confident
 * nonsense. Declining sends the request to Ollama instead.
 */
export async function detectLanguage(
  text: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const detectors = detectorFactory();
  if (!detectors) return null;
  try {
    const detector = await detectors.create({ signal });
    const results = await detector.detect(text.slice(0, 1000));
    detector.destroy?.();
    const best = results[0];
    // A last resort, so the bar is low. It only runs when the page declined to
    // say what language it is in, and on the short fragments that make a
    // detector unsure — captions, citations, proper nouns — a low-confidence
    // "en" still beats refusing to translate. Anything Chrome has no language
    // pack for is rejected a step later anyway.
    if (!best || best.confidence < MIN_DETECTION_CONFIDENCE) return null;
    return best.detectedLanguage;
  } catch {
    return null;
  }
}

/**
 * Detector confidence below which its guess is discarded.
 *
 * Deliberately low. Measured on one Wikipedia article, six blocks scored under
 * 0.5 — "Ollama running Llama 3 in Linux" at 0.248 — and every one of them was
 * plain English that translates fine.
 */
const MIN_DETECTION_CONFIDENCE = 0.2;

/** Thrown when the built-in engine cannot serve a request, so a caller falls back. */
export class BuiltinUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuiltinUnavailableError';
  }
}

export interface BuiltinStreamParams {
  text: string;
  targetLang: string;
  /**
   * What the page says it is written in (`<html lang>`). Used ahead of
   * detection, because the page knows and a detector handed forty characters
   * of caption does not.
   */
  sourceLang?: string;
  signal?: AbortSignal;
  onChunk: (chunk: string) => void;
  /** 0–1, while Chrome downloads the language pack on first use. */
  onDownloadProgress?: (loaded: number) => void;
}

/**
 * Translate `text`, delivering the result through `onChunk`.
 *
 * Streams when Chrome offers `translateStreaming`, so the panel paints
 * progressively on a long selection exactly as it does for Ollama; falls back
 * to one chunk otherwise. Either way the caller cannot tell which engine ran,
 * which is what keeps the UI free of engine-specific branches.
 *
 * Throws `BuiltinUnavailableError` for every "this engine cannot do it" case —
 * unsupported browser, unmapped language, no language pack, undetectable
 * source — so the broker has one condition to catch and fall back on.
 */
export async function translateBuiltin({
  text,
  targetLang,
  sourceLang,
  signal,
  onChunk,
  onDownloadProgress,
}: BuiltinStreamParams): Promise<void> {
  if (!text.trim()) return;

  const translators = factory();
  if (!translators) {
    throw new BuiltinUnavailableError(
      'This browser has no built-in translator (Chrome 138+ does).',
    );
  }

  const targetLanguage = toBcp47(targetLang);
  if (!targetLanguage) {
    throw new BuiltinUnavailableError(
      `The built-in translator has no code for "${targetLang}".`,
    );
  }

  // The page's own declaration first; detection only when it made none.
  const sourceLanguage =
    normaliseLang(sourceLang) ?? (await detectLanguage(text, signal));
  if (!sourceLanguage) {
    throw new BuiltinUnavailableError(
      'Could not tell what language this is written in.',
    );
  }

  // Same language in and out is not a translation, and Chrome has no pack for
  // it. The selection UI already short-circuits the Chinese case; this covers
  // an English page being asked for English.
  if (baseLanguage(sourceLanguage) === baseLanguage(targetLanguage)) {
    onChunk(text);
    return;
  }

  const availability = await translators.availability({
    sourceLanguage,
    targetLanguage,
  });
  if (availability === 'unavailable') {
    throw new BuiltinUnavailableError(
      `Chrome has no ${sourceLanguage} → ${targetLanguage} language pack.`,
    );
  }

  const translator = await translators.create({
    sourceLanguage,
    targetLanguage,
    signal,
    monitor: onDownloadProgress
      ? (monitor) => {
          monitor.addEventListener('downloadprogress', (event) => {
            onDownloadProgress(event.loaded);
          });
        }
      : undefined,
  });

  try {
    const stream = translator.translateStreaming?.(text);
    if (stream) {
      const reader = stream.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        if (value) onChunk(value);
      }
      return;
    }
    const result = await translator.translate(text);
    if (!signal?.aborted && result) onChunk(result);
  } finally {
    translator.destroy?.();
  }
}
