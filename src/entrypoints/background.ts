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
  TRANSLATE_SELECTION_COMMAND,
  type TranslateSelectionMessage,
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

  /** Send one tab into the bundled viewer, if it is a PDF we may open. */
  async function routeToViewer(tabId: number, url: string): Promise<void> {
    if (!isPdfUrl(url) || url.startsWith(viewerUrl)) return;
    if (url.startsWith('file://')) {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (!allowed) return;
    }
    await chrome.tabs.update(tabId, {
      url: `${viewerUrl}?file=${encodeURIComponent(url)}`,
    });
  }

  // Auto-redirect PDF navigations into the vendored PDF.js viewer.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading' || !tab.url) return;
    void routeToViewer(tabId, tab.url);
  });

  /**
   * The listener above only sees navigations that happen while this worker is
   * alive. Open the browser straight onto a PDF — a restored session, or a .pdf
   * link clicked from outside Chrome — and the navigation is already past
   * `loading` by the time MV3 gets around to starting the worker, so the tab
   * stays in Chrome's own viewer. Measured: launching with a PDF as the startup
   * page landed in the built-in viewer every time, while browsing first and then
   * opening the same PDF worked. Sweeping the open tabs on wake covers the gap.
   */
  function routeExistingPdfTabs(): void {
    void (async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id === undefined || !tab.url) continue;
        await routeToViewer(tab.id, tab.url).catch(() => undefined);
      }
    })();
  }
  chrome.runtime.onStartup.addListener(routeExistingPdfTabs);
  chrome.runtime.onInstalled.addListener(routeExistingPdfTabs);

  // Keyboard shortcut: a selection made with the keyboard produces no mouseup,
  // so the floating 文 icon is not a route a keyboard user can take. Broadcast
  // to every frame in the active tab; only the one holding a selection acts.
  chrome.commands?.onCommand.addListener((command) => {
    if (command !== TRANSLATE_SELECTION_COMMAND) return;
    void (async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) return;
      const message: TranslateSelectionMessage = {
        type: 'TRANSLATE_SELECTION',
      };
      // No receiver in a frame without our content script; that is expected.
      await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
    })();
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
