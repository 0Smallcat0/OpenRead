import { mountSelectionTranslator } from '../ui/selection';
import { showPageNotice } from '../ui/fullpage';
import { loadSettings } from '../settings';

/**
 * Runs inside the vendored PDF.js viewer page (loaded by viewer.html as a
 * bundled module at the extension root). The PDF text layer exposes selectable
 * spans, so the exact same selection translator used on web pages works here
 * verbatim — collapsing v1's pdf-integration.js (a ~90% copy of content.js)
 * into a one-line reuse of the shared `ui/selection.ts` module.
 *
 * Whole-page translation deliberately does not work here, and says so. A PDF
 * text layer is absolutely-positioned spans laid over the rendered page, one
 * per line; appending a translation under each would land it on top of the
 * next line and destroy the document. The context menu still offers the action
 * on this page, as it does everywhere, so the honest response is a refusal
 * rather than a click that appears to do nothing.
 */
export default defineUnlistedScript(() => {
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

  chrome.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string } | null)?.type !== 'TRANSLATE_PAGE') {
      return;
    }
    showPageNotice(
      document,
      'Whole-page translation is not available in the PDF viewer — select text to translate it.',
    );
  });
});
