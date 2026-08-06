import { mountSelectionTranslator } from '../ui/selection';
import { togglePageTranslation, translatePage } from '../ui/fullpage';
import { translateViaPort } from '../ui/port-translate';
import { shouldBypassAI } from '../core/language';
import { shouldAutoTranslate } from '../core/auto-translate';
import { loadSettings, type Settings } from '../settings';
import type { PageLanguageResponse } from '../messaging';

/**
 * Web-page content script: mounts the shared selection translator on every
 * frame, and handles whole-page translation on the top frame. Model + target
 * language are read from storage at translate time so changes in the popup
 * take effect without a reload. No secret is involved — inference is local;
 * the background broker holds the Ollama server URL.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_end',
  main() {
    mountSelectionTranslator({
      getSettings: async () => {
        const s = await loadSettings();
        return {
          engine: s.engine,
          modelId: s.modelId,
          targetLang: s.targetLang,
          obsidianVault: s.obsidianVault,
          obsidianFolder: s.obsidianFolder,
          enrichOnCapture: s.enrichOnCapture,
        };
      },
    });

    // Only the top frame translates the page. Every frame receives the
    // broadcast, and an ad iframe running its own pass would spend the user's
    // GPU on someone else's banner while stacking a second progress badge in
    // the same corner.
    if (window.top !== window) return;

    const pageDeps = (settings: Settings, unprompted = false) => ({
      targetLang: settings.targetLang,
      unprompted,
      translate: (
        text: string,
        signal: AbortSignal,
        attempt: number,
        onDownloadProgress?: (loaded: number) => void,
      ) =>
        translateViaPort({
          text,
          targetLang: settings.targetLang,
          model: settings.modelId,
          signal,
          retryCount: attempt,
          onDownloadProgress,
        }),
      // The same short-circuit selection uses: a block already in the
      // target language costs a full round trip to say nothing.
      shouldSkipText: (text: string) =>
        shouldBypassAI(text, settings.targetLang),
    });

    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse) => {
        const type = (message as { type?: string } | null)?.type;

        // Answered synchronously, so no `return true` is needed and the popup
        // is never left waiting on a channel that closed.
        if (type === 'PAGE_LANGUAGE') {
          const response: PageLanguageResponse = {
            lang: document.documentElement.getAttribute('lang'),
          };
          sendResponse(response);
          return;
        }

        if (type !== 'TRANSLATE_PAGE') return;
        void (async () => {
          const settings = await loadSettings();
          await togglePageTranslation(document, pageDeps(settings));
        })();
      },
    );

    // Translate without being asked, when the user has asked for that in
    // general. `translatePage` rather than the toggle: a page that arrives
    // already carrying a translation — a back-navigation restoring the bfcache
    // — must not have it wiped by the automatic pass, which is what the toggle
    // would do.
    void (async () => {
      const settings = await loadSettings();
      if (settings.autoTranslate === 'off') return;
      // Read from the page rather than from `navigator.language`: what matters
      // is what this document says it is, not what the browser is set to.
      const sample = Array.from(document.querySelectorAll('p, h1, h2, h3, li'))
        .slice(0, 20)
        .map((element) => element.textContent ?? '')
        .join(' ')
        .slice(0, 1000);
      const decided = shouldAutoTranslate({
        mode: settings.autoTranslate,
        host: location.hostname,
        except: settings.autoTranslateExcept,
        pageLang: document.documentElement.getAttribute('lang'),
        sample,
        targetLang: settings.targetLang,
      });
      if (decided) await translatePage(document, pageDeps(settings, true));
    })();
  },
});
