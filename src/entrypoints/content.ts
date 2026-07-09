import { mountSelectionTranslator } from '../ui/selection';
import { loadSettings } from '../settings';

/**
 * Web-page content script: mounts the shared selection translator on every
 * frame. Model + target language are read from storage at translate time so
 * changes in the popup take effect without a reload. No secret is involved —
 * inference is local; the background broker holds the Ollama server URL.
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
  },
});
