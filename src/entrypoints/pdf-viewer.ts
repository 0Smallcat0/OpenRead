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
/**
 * Make the text layer as easy to grab as a paragraph is.
 *
 * PDF.js sizes each line's span tightly around its glyphs, so the space
 * between two lines belongs to neither of them — pressing there is pressing on
 * the rendered page, and the drag selects nothing. A web page does not behave
 * that way: a paragraph's box carries its line-height leading, so a press a
 * few pixels high still lands on the nearest text.
 *
 * Measured on a five-line page: line boxes 15px tall, 27px apart, leaving 12px
 * that nothing owns. Starting a drag 4px above a line selected nothing at all
 * — and did so with the extension unloaded too, so this is the viewer's
 * behaviour rather than ours.
 *
 * Padding grows the box; the negative margin puts the glyphs back where PDF.js
 * put them. 5px a side leaves 2px between boxes, so a point still belongs to
 * exactly one line and the mapping stays unambiguous.
 */
const HIT_AREA_STYLE = `
.textLayer span {
  padding-block: 5px;
  margin-block: -5px;
}
`;

function widenTextLayerHitArea(): void {
  const style = document.createElement('style');
  style.id = 'oit-pdf-hit-area';
  style.textContent = HIT_AREA_STYLE;
  (document.head ?? document.documentElement).appendChild(style);
}

export default defineUnlistedScript(() => {
  widenTextLayerHitArea();

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
