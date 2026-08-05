import { mountSelectionTranslator } from '../ui/selection';
import { togglePageTranslation } from '../ui/fullpage';
import { translateViaPort } from '../ui/port-translate';
import { shouldBypassAI } from '../core/language';
import { loadSettings } from '../settings';

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

    chrome.runtime.onMessage.addListener((message: unknown) => {
      if ((message as { type?: string } | null)?.type !== 'TRANSLATE_PAGE') {
        return;
      }
      void (async () => {
        const settings = await loadSettings();
        await togglePageTranslation(document, {
          targetLang: settings.targetLang,
          translate: (text, signal, attempt, onDownloadProgress) =>
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
          shouldSkipText: (text) => shouldBypassAI(text, settings.targetLang),
        });
      })();
    });
  },
});
