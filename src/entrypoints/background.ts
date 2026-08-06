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
import { translateBuiltin, BuiltinUnavailableError } from '../api/builtin';
import { buildOriginStripRule, ORIGIN_STRIP_RULE_ID } from '../core/dnr-rule';
import { describeEngineFailure } from '../core/diagnostics';
import {
  STREAM_PORT_NAME,
  TRANSLATE_SELECTION_COMMAND,
  TRANSLATE_PAGE_COMMAND,
  type TranslateSelectionMessage,
  type TranslatePageMessage,
  type PortRequest,
  type RuntimeRequest,
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
  /**
   * Let this extension reach Ollama without the user configuring anything.
   *
   * Ollama 403s any request whose Origin it does not know, and an extension's
   * origin is never on its list, so every install used to begin with an
   * OLLAMA_ORIGINS environment variable and a server restart. The rule strips
   * the header from this extension's own requests to the configured server
   * only; see `core/dnr-rule.ts` for why that does not also hand every web
   * page an unauthenticated local model.
   *
   * Session-scoped rather than dynamic: it is cheap to rebuild, and a rule
   * that outlives the browser would keep pointing at a server the user may
   * have since changed.
   */
  async function applyOriginStripRule(): Promise<void> {
    const { baseUrl } = await loadSettings();
    const rule = buildOriginStripRule(baseUrl);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ORIGIN_STRIP_RULE_ID],
      addRules: rule ? [rule] : [],
    });
  }

  /**
   * Resolves once the rule is in force. Every outbound request waits on it.
   *
   * Installing the rule is asynchronous, and an MV3 worker starts cold — it is
   * woken *by* the first request, so without this the request that woke it can
   * reach the network first and take a 403 the user did nothing to deserve.
   * Caught by the browser harness against a stock server: with two blocks in
   * flight, exactly the first one failed. Awaiting a settled promise costs
   * nothing on every request after the first.
   */
  let originRuleReady = applyOriginStripRule();

  chrome.runtime.onStartup.addListener(() => {
    originRuleReady = applyOriginStripRule();
  });
  chrome.runtime.onInstalled.addListener(() => {
    originRuleReady = applyOriginStripRule();
  });
  // Pointing the extension at a different server has to move the rule with it,
  // or the new server answers 403 and the old one stays reachable.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && 'baseUrl' in changes) {
      originRuleReady = applyOriginStripRule();
    }
  });

  chrome.runtime.onStartup.addListener(routeExistingPdfTabs);
  chrome.runtime.onInstalled.addListener(routeExistingPdfTabs);

  // Keyboard shortcut: a selection made with the keyboard produces no mouseup,
  // so the floating 文 icon is not a route a keyboard user can take. Broadcast
  // to every frame in the active tab; only the one holding a selection acts.
  chrome.commands?.onCommand.addListener((command) => {
    const message: TranslateSelectionMessage | TranslatePageMessage | null =
      command === TRANSLATE_SELECTION_COMMAND
        ? { type: 'TRANSLATE_SELECTION' }
        : command === TRANSLATE_PAGE_COMMAND
          ? { type: 'TRANSLATE_PAGE' }
          : null;
    if (!message) return;
    void (async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) return;
      // No receiver in a frame without our content script; that is expected.
      await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
    })();
  });

  /**
   * Right-click entry points.
   *
   * The whole-page feature shipped reachable only from the toolbar popup and
   * a keyboard shortcut — which, it turned out, Chrome had never assigned.
   * Neither is where anyone looks in any case. A user with the
   * extension installed opened the context menu, found Chrome's own translate
   * item and not this one, and asked where the feature had gone — which is the
   * answer to whether a popup button counts as discoverable.
   *
   * Two items, so the menu offers whichever one matches what is under the
   * cursor: a selection, or the page.
   */
  const MENU_PAGE = 'openread-translate-page';
  const MENU_SELECTION = 'openread-translate-selection';

  function createMenus(): void {
    // Rebuild rather than add: the worker can restart at any time, and
    // `create` on an id that already exists is an error.
    chrome.contextMenus?.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_SELECTION,
        title: 'Translate selection with OpenRead',
        contexts: ['selection'],
      });
      chrome.contextMenus.create({
        id: MENU_PAGE,
        title: 'Translate this page with OpenRead',
        contexts: ['page'],
      });
      // `create` reports failures here rather than throwing.
      void chrome.runtime.lastError;
    });
  }

  createMenus();
  chrome.runtime.onInstalled.addListener(createMenus);

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    const message: TranslateSelectionMessage | TranslatePageMessage | null =
      info.menuItemId === MENU_SELECTION
        ? { type: 'TRANSLATE_SELECTION' }
        : info.menuItemId === MENU_PAGE
          ? { type: 'TRANSLATE_PAGE' }
          : null;
    if (!message || tab?.id === undefined) return;
    // No receiver on a page without our content script; that is expected.
    void chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
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
        const { engine, baseUrl } = await loadSettings();

        // Why the built-in engine bowed out, kept for the message below. Null
        // whenever it never ran or never failed.
        let builtinReason: string | null = null;

        // Chrome's own translator first, when it is the chosen engine. It
        // needs no server, so it is tried before the rule that exists to let
        // one be reached.
        if (engine === 'builtin') {
          try {
            await translateBuiltin({
              text: message.text,
              targetLang: message.targetLang,
              sourceLang: message.sourceLang,
              signal,
              onChunk: (chunk) => post({ status: 'streaming', chunk }),
              // Without this the first use of a language pair is a silent
              // two-minute wait, which reads as a broken extension.
              onDownloadProgress: (loaded) =>
                post({ status: 'downloading', loaded }),
            });
            post({ status: 'done' });
            return;
          } catch (error) {
            if (signal.aborted || (error as Error).name === 'AbortError') {
              return;
            }
            // Anything the built-in engine simply cannot do — a language it
            // has no pack for, an undetectable source, an older browser —
            // falls through to Ollama rather than surfacing as a failure. A
            // real error from it does not: that would hide a bug behind a
            // second engine.
            if (!(error instanceof BuiltinUnavailableError)) {
              post({ status: 'error', message: (error as Error).message });
              return;
            }
            builtinReason = error.message;
          }
        }

        await originRuleReady;
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
              ? `Can't reach Ollama at ${baseUrl}. Is the server running?`
              : (error as Error).message;
          // Ollama's message alone is the wrong answer for a user who never
          // chose Ollama and only landed here because the built-in engine
          // could not serve them.
          post({
            status: 'error',
            message: describeEngineFailure(builtinReason, message_),
          });
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
      if (request.type === 'ENRICH_CAPTURE') {
        void (async () => {
          await originRuleReady;
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
