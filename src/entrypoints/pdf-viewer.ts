import { mountSelectionTranslator } from '../ui/selection';
import { loadSettings } from '../settings';

/**
 * Runs inside the vendored PDF.js viewer page (loaded by viewer.html as a
 * bundled module at the extension root). The PDF text layer exposes selectable
 * spans, so the exact same selection translator used on web pages works here
 * verbatim — collapsing v1's pdf-integration.js (a ~90% copy of content.js)
 * into a one-line reuse of the shared `ui/selection.ts` module.
 */
export default defineUnlistedScript(() => {
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
    // The PDF viewer's overlay CSS targets this class to keep the close button
    // above the rendered page.
    closeButtonClass: 'oit-close-btn',
  });
});
