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
  | { status: 'done' }
  | { status: 'error'; message: string };

/** content -> background one-shot: ask to open a file:// PDF in the viewer. */
export interface OpenPdfViewerMessage {
  type: 'OPEN_PDF_VIEWER';
  url: string;
}

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

/** The command ids declared in the manifest, and the messages they produce. */
export const TRANSLATE_SELECTION_COMMAND = 'translate-selection';
export const TRANSLATE_PAGE_COMMAND = 'translate-page';

export type RuntimeRequest =
  | OpenPdfViewerMessage
  | EnrichCaptureMessage
  | TranslateSelectionMessage
  | TranslatePageMessage;

export type OpenPdfViewerResponse =
  { success: true } | { error: 'PERMISSION_DENIED' };

/** background -> content: the parsed enrichment, or null on any failure. */
export interface EnrichCaptureResponse {
  result: EnrichResult | null;
}
