/**
 * One translation over the streaming port, delivered as a whole string.
 *
 * The selection UI wants deltas — that is the entire point of streaming into a
 * panel. Whole-page translation wants the finished text: a paragraph is
 * inserted once it is complete, because a block that grows word by word while
 * the reader is two paragraphs below only reflows the page under them.
 *
 * Same broker, same pipeline, same reliability layer. This is a different
 * consumer of the stream, not a different path through it.
 */
import {
  STREAM_PORT_NAME,
  type StartStreamMessage,
  type StreamResponse,
} from '../messaging';

export interface PortTranslateParams {
  text: string;
  targetLang: string;
  model: string;
  signal: AbortSignal;
  /** 0 for the first try; the broker raises temperature above that. */
  retryCount?: number;
  /** Called while Chrome downloads a language pack, 0-1. */
  onDownloadProgress?: (loaded: number) => void;
  /**
   * Whether the page's own `<html lang>` describes this text.
   *
   * True for anything read off the page, which is nearly everything. False for
   * a box the reader is typing in: they are writing in the language they think
   * in, which is precisely not the one the page is written in — and handing the
   * engine `en` for Chinese input made it answer with the Chinese, unchanged,
   * which the UI then reported as "it is already in that language".
   */
  fromPageLanguage?: boolean;
}

export function translateViaPort({
  text,
  targetLang,
  model,
  signal,
  retryCount,
  onDownloadProgress,
  fromPageLanguage = true,
}: PortTranslateParams): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    let full = '';
    let settled = false;

    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      port.disconnect();
      run();
    };

    function onAbort(): void {
      finish(() => {
        reject(new Error('aborted'));
      });
    }
    signal.addEventListener('abort', onAbort);

    port.onMessage.addListener((response: StreamResponse) => {
      if (response.status === 'streaming') {
        full += response.chunk;
      } else if (response.status === 'downloading') {
        onDownloadProgress?.(response.loaded);
      } else if (response.status === 'error') {
        finish(() => {
          reject(new Error(response.message));
        });
      } else {
        finish(() => {
          resolve(full);
        });
      }
    });

    // A worker that dies mid-generation disconnects without a `done`, which
    // would otherwise leave this promise pending and stall the whole queue.
    port.onDisconnect.addListener(() => {
      finish(() => {
        reject(
          new Error('The background worker disconnected mid-translation.'),
        );
      });
    });

    const message: StartStreamMessage = {
      type: 'START_STREAM',
      text,
      targetLang,
      model,
      retryCount,
      // The page knows what it is written in; a detector handed one caption
      // does not. Omitted where the page cannot know — see `fromPageLanguage`.
      sourceLang: fromPageLanguage
        ? document.documentElement.lang || undefined
        : undefined,
    };
    port.postMessage(message);
  });
}
