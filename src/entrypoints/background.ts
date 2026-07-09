/**
 * Background service worker: the streaming translation broker and PDF router.
 *
 * - Streams: one long-lived `stream-translate` port per active translation.
 *   Each port owns a single AbortController; a new START_STREAM cancels the
 *   previous request, and a disconnect aborts in-flight work. The Ollama base
 *   URL is loaded from storage here; inference runs on the user's machine.
 * - PDF routing: `.pdf` navigations are redirected into the bundled viewer.
 */
import { translateStream, enrichText } from '../api/ollama';
import { loadSettings } from '../settings';
import {
  STREAM_PORT_NAME,
  type PortRequest,
  type RuntimeRequest,
  type OpenPdfViewerResponse,
  type EnrichCaptureResponse,
  type StreamResponse,
} from '../messaging';

export default defineBackground(() => {
  const viewerUrl = chrome.runtime.getURL('pdfjs/web/viewer.html');

  function isPdfUrl(url: string): boolean {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.pdf');
    } catch {
      return false;
    }
  }

  // Auto-redirect PDF navigations into the vendored PDF.js viewer.
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading' || !tab.url) return;
    if (!isPdfUrl(tab.url) || tab.url.startsWith(viewerUrl)) return;
    if (tab.url.startsWith('file://')) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (!allowed) return;
    }
    void chrome.tabs.update(tabId, {
      url: `${viewerUrl}?file=${encodeURIComponent(tab.url)}`,
    });
  });

  // Streaming translation broker.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== STREAM_PORT_NAME) return;
    let controller: AbortController | null = null;

    const post = (message: StreamResponse): void => {
      try {
        port.postMessage(message);
      } catch {
        // Port already closed by the other side — nothing to do.
      }
    };

    port.onMessage.addListener((message: PortRequest) => {
      if (message.type !== 'START_STREAM') return;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;

      void (async () => {
        const { baseUrl } = await loadSettings();
        try {
          await translateStream({
            text: message.text,
            baseUrl,
            model: message.model,
            targetLang: message.targetLang,
            context: message.context,
            retryCount: message.retryCount ?? 0,
            signal,
            onChunk: (chunk) => post({ status: 'streaming', chunk }),
          });
          post({ status: 'done' });
        } catch (error) {
          if (signal.aborted || (error as Error).name === 'AbortError') return;
          // A network TypeError almost always means the local Ollama server
          // isn't running or hasn't allowed this extension's origin.
          const message_ =
            error instanceof TypeError
              ? `Can't reach Ollama at ${baseUrl}. Is it running, and is OLLAMA_ORIGINS set to allow this extension?`
              : (error as Error).message;
          post({ status: 'error', message: message_ });
        }
      })();
    });

    port.onDisconnect.addListener(() => controller?.abort());
  });

  // One-shot handlers: open a local PDF in the viewer, or run a best-effort
  // enrichment pass for a capture. Both keep the channel open for an async
  // response (`return true`).
  chrome.runtime.onMessage.addListener(
    (request: RuntimeRequest, sender, sendResponse) => {
      if (request.type === 'OPEN_PDF_VIEWER') {
        void (async () => {
          const allowed = await chrome.extension.isAllowedFileSchemeAccess();
          const response: OpenPdfViewerResponse = allowed
            ? { success: true }
            : { error: 'PERMISSION_DENIED' };
          if (allowed && sender.tab?.id !== undefined) {
            await chrome.tabs.update(sender.tab.id, {
              url: `${viewerUrl}?file=${encodeURIComponent(request.url)}`,
            });
          }
          sendResponse(response);
        })();
        return true;
      }

      if (request.type === 'ENRICH_CAPTURE') {
        void (async () => {
          const { baseUrl } = await loadSettings();
          let result = null;
          try {
            result = await enrichText({
              text: request.text,
              baseUrl,
              model: request.model,
              targetLang: request.targetLang,
            });
          } catch {
            // Best-effort: any failure falls back to a raw capture.
            result = null;
          }
          const response: EnrichCaptureResponse = { result };
          sendResponse(response);
        })();
        return true;
      }

      return undefined;
    },
  );
});
