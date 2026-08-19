/**
 * Typed message protocol between the content scripts and the background service
 * worker. Centralising these discriminated unions means both sides share one
 * source of truth and the compiler catches shape drift.
 *
 * Note: there is no API key — inference is local via Ollama. Messages carry
 * only the text, target language, and model; the background broker reads the
 * Ollama server URL from `chrome.storage` itself.
 */
import type { TranslationContext, EnrichResult } from './core/types';

/** Long-lived port used for streaming translations. */
export const STREAM_PORT_NAME = 'stream-translate';

/** content -> background over the stream port. */
export interface StartStreamMessage {
  type: 'START_STREAM';
  text: string;
  targetLang: string;
  model: string;
  context?: TranslationContext;
  /**
   * What language the page says it is in (`<html lang>`), when it says.
   *
   * Chrome's built-in translator needs a source language, and detecting one
   * per block guesses badly on the short fragments a real page is full of —
   * captions, citations, proper nouns. Measured on one Wikipedia article: six
   * blocks came back under 0.5 confidence, including "Ollama running Llama 3
   * in Linux" at 0.25. The page already knows the answer, so it tells us.
   */
  sourceLang?: string;
  /** 0 for the first attempt; the broker raises temperature on retries. */
  retryCount?: number;
}

export type PortRequest = StartStreamMessage;

/** background -> content over the stream port. */
export type StreamResponse =
  | { status: 'streaming'; chunk: string }
  /**
   * Chrome is fetching a language pack, 0-1 complete.
   *
   * Only the built-in engine sends this, and only the first time a language
   * pair is used — but that first time is around two minutes, and without a
   * message the UI simply sits there. Switching target language is the common
   * way to meet it: every new pair is a new download.
   */
  | { status: 'downloading'; loaded: number }
  | { status: 'done' }
  | { status: 'error'; message: string };

/**
 * content -> background one-shot: run an optional local-model enrichment pass
 * for a capture. The broker reads the Ollama base URL from storage itself, so
 * (like translation) it never rides the message bus.
 */
export interface EnrichCaptureMessage {
  type: 'ENRICH_CAPTURE';
  text: string;
  targetLang: string;
  model: string;
}

/**
 * background -> content one-shot: the user pressed the keyboard shortcut, so
 * translate whatever is selected. Broadcast to every frame; only the one
 * holding a selection acts.
 */
export interface TranslateSelectionMessage {
  type: 'TRANSLATE_SELECTION';
}

/**
 * popup or background -> content one-shot: translate the whole page, or undo
 * a translation already on it. One message for both because the control is one
 * button whose meaning follows the page's state.
 */
export interface TranslatePageMessage {
  type: 'TRANSLATE_PAGE';
}

/**
 * popup -> content one-shot: what language does this page say it is in?
 *
 * Asked so the popup can report on the language pair the next translation will
 * actually use. Chrome's packs are per-pair, and telling a reader of Japanese
 * pages that `en`→`zh-Hant` is ready would be worse than saying nothing.
 */
export interface PageLanguageMessage {
  type: 'PAGE_LANGUAGE';
}

/** content -> popup: `<html lang>`, or null when the page does not say. */
export interface PageLanguageResponse {
  lang: string | null;
}

/**
 * background -> content one-shot: translate whatever text box has focus.
 *
 * Broadcast like the selection message; only the frame holding the focused
 * field has anything to do.
 */
export interface TranslateInputMessage {
  type: 'TRANSLATE_INPUT';
}

/** The command ids declared in the manifest, and the messages they produce. */
export const TRANSLATE_SELECTION_COMMAND = 'translate-selection';
export const TRANSLATE_PAGE_COMMAND = 'translate-page';
export const TRANSLATE_INPUT_COMMAND = 'translate-input';

/**
 * content -> background: this tab is showing a PDF, put it in our viewer.
 *
 * The URL is not sent: the background reads it from `sender.tab`, which the
 * page cannot forge, and a tab id from a message it did not originate is a
 * request to navigate somebody else's tab.
 */
export interface OpenInViewerMessage {
  type: 'OPEN_IN_VIEWER';
}

/**
 * popup -> background: is the worker fetching a language pack right now?
 *
 * Asked because `Translator.availability()` cannot answer it. It reports
 * `downloadable` for the entire duration of a download it is itself
 * performing — measured at 145,687 ms of `create()` with availability never
 * once saying `downloading` — so a popup that trusts it tells a user whose
 * pack is 40% of the way in that nothing has been downloaded yet, and offers
 * them a button to start what is already running. The worker knows.
 */
export interface PackProgressMessage {
  type: 'PACK_PROGRESS';
}

/**
 * popup -> background: fetch this pair, and own it.
 *
 * The popup used to run the download itself, on the grounds that Chrome's
 * gate on starting one wants a user gesture and a message to the worker would
 * throw that gesture away. The gate is real in a document and absent in a
 * service worker, so the worker can do it — and it is the only context that
 * should, because closing the popup kills a download running in it.
 *
 * That is not a lost minute. Measured: `en`→`fr` interrupted at 85 MB and
 * asked for again sat at zero for three minutes, then Chrome deleted the 85 MB
 * and started from the beginning. A user who opens the popup, starts the
 * download and closes the window has paid for nothing and added three minutes.
 */
export interface PackFetchMessage {
  type: 'PACK_FETCH';
  /** BCP-47, both. The popup knows the page's language; the worker does not. */
  source: string;
  target: string;
}

/** background -> popup: whether a pack is in flight, and how far in. */
export interface PackProgressResponse {
  /** True while the worker's own prefetch is running. */
  downloading: boolean;
  /**
   * 0-1, and coarse: Chrome's monitor fired 479 times for one pair and twice
   * for another. Zero means "started, nothing reported yet", not "no progress".
   */
  loaded: number;
  /**
   * Why the last attempt gave up, or null if none has.
   *
   * A pack download that has given up is the failure a new install actually
   * meets, and until this existed the worker met it with a `console.warn`
   * nobody opens a devtools window on a service worker to read. The popup is
   * where a user who just installed the thing is already looking.
   */
  problem: string | null;
}

export type RuntimeRequest =
  | EnrichCaptureMessage
  | OpenInViewerMessage
  | TranslateSelectionMessage
  | TranslatePageMessage
  | TranslateInputMessage
  | PackProgressMessage
  | PackFetchMessage
  | PageLanguageMessage;

/** background -> content: the parsed enrichment, or null on any failure. */
export interface EnrichCaptureResponse {
  result: EnrichResult | null;
}
