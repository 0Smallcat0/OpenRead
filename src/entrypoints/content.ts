import { mountSelectionTranslator } from '../ui/selection';
import { mountHoverTranslate } from '../ui/hover';
import {
  togglePageTranslation,
  translatePage,
  translateBlock,
  applyAppearance,
  reflowTranslations,
} from '../ui/fullpage';
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
      appearance: {
        displayMode: settings.displayMode,
        translationStyle: settings.translationStyle,
        translationScale: settings.translationScale,
      },
    });

    // Point at a paragraph with a key held and get that paragraph. Mounted on
    // every frame, like selection: the unit is one block, and a block inside an
    // iframe is as worth translating as one outside it.
    mountHoverTranslate(document, {
      getKey: async () => (await loadSettings()).hoverTranslate,
      translateBlock: async (block) => {
        const settings = await loadSettings();
        return translateBlock(block, pageDeps(settings));
      },
    });

    // Only the top frame translates the page. Every frame receives the
    // broadcast, and an ad iframe running its own pass would spend the user's
    // GPU on someone else's banner while stacking a second progress badge in
    // the same corner.
    if (window.top !== window) return;


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

    // Appearance follows the popup without a reload. Style and size are pure
    // CSS and change with the attribute alone; the display mode has to add or
    // remove the wrapper that hides the original, which is what `reflow` does.
    // A translated page the reader is looking at while they try the settings is
    // exactly when this matters.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (
        !('displayMode' in changes) &&
        !('translationStyle' in changes) &&
        !('translationScale' in changes)
      ) {
        return;
      }
      void loadSettings().then((settings) => {
        applyAppearance(document, {
          displayMode: settings.displayMode,
          translationStyle: settings.translationStyle,
          translationScale: settings.translationScale,
        });
        if ('displayMode' in changes) {
          reflowTranslations(document, settings.displayMode);
        }
      });
    });

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
