/**
 * Typed message protocol between the content scripts and the background service
 * worker. Centralising these discriminated unions means both sides share one
 * source of truth and the compiler catches shape drift.
 *
 * Note: there is no API key — inference is local via Ollama. Messages carry
 * only the text, target language, and model; the background broker reads the
 * Ollama server URL from `chrome.storage` itself.
 */
import type { TranslationContext } from './core/types';

/** Long-lived port used for streaming translations. */
export const STREAM_PORT_NAME = 'stream-translate';

/** content -> background over the stream port. */
export interface StartStreamMessage {
  type: 'START_STREAM';
  text: string;
  targetLang: string;
  model: string;
  context?: TranslationContext;
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

export type RuntimeRequest = OpenPdfViewerMessage;

export type OpenPdfViewerResponse =
  { success: true } | { error: 'PERMISSION_DENIED' };
