import { mountSelectionTranslator } from '../ui/selection';
import { togglePdfTranslation } from '../ui/pdf-translate';
import { translateViaPort } from '../ui/port-translate';
import { shouldBypassAI } from '../core/language';
import { loadSettings } from '../settings';

/**
 * Runs inside the vendored PDF.js viewer page (loaded by viewer.html as a
 * bundled module at the extension root). The PDF text layer exposes selectable
 * spans, so the exact same selection translator used on web pages works here
 * verbatim — collapsing v1's pdf-integration.js (a ~90% copy of content.js)
 * into a one-line reuse of the shared `ui/selection.ts` module.
 *
 * Whole-document translation works here too, and the constraint that used to
 * rule it out is the reason it looks the way it does. A PDF text layer is
 * absolutely-positioned spans laid over the rendered page, so a translation
 * appended under a line lands on the next one. But the pages are ordinary
 * block elements stacked in `#viewer`, so a translation placed *after a page*
 * costs nothing — and reads in order: the page as the author laid it out, then
 * that page in the reader's language. Which is also how a paper is read.
 * Nobody wants a two-column PDF reflowed into one; they want to see the figure
 * and read the argument. See `ui/pdf-translate.ts`.
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

/**
 * How far a line's hit box may reach into the page margins.
 *
 * A web page's paragraph runs the width of its container, so a drag that
 * starts in the margin still lands on the line. In the viewer the span stops
 * at the first glyph, and a press 40px to its left selected nothing at all —
 * which is most of what "PDFs are hard to select in" turns out to mean.
 */
const MARGIN_REACH = 60;

/** Same-line grouping tolerance, in pixels of vertical offset. */
const SAME_LINE = 4;

/**
 * Close the gaps between the boxes of one rendered page.
 *
 * PDF.js emits one span per text run, so a line is several boxes with dead
 * space between them and dead margins either side. Each box is widened to meet
 * its neighbours — half the gap each way — and the outermost ones reach into
 * the margin. Padding grows the box while a matching negative margin leaves
 * the glyphs exactly where PDF.js put them, so nothing moves on screen and
 * character mapping inside a span is unaffected: the text still begins at the
 * same x.
 */
function widenLineBoxes(layer: Element): void {
  const spans = Array.from(layer.querySelectorAll<HTMLElement>('span')).filter(
    (span) => span.textContent?.trim(),
  );
  if (spans.length === 0) return;

  const measured = spans.map((span) => ({
    span,
    box: span.getBoundingClientRect(),
  }));
  const layerBox = layer.getBoundingClientRect();

  // Group by line. Sorting by top then left puts a line's runs in order even
  // when the PDF emitted them out of order, which justified text does.
  const lines = new Map<number, typeof measured>();
  for (const item of measured) {
    const key = [...lines.keys()].find(
      (top) => Math.abs(top - item.box.top) <= SAME_LINE,
    );
    if (key === undefined) lines.set(item.box.top, [item]);
    else lines.get(key)?.push(item);
  }

  for (const runs of lines.values()) {
    runs.sort((a, b) => a.box.left - b.box.left);
    for (let i = 0; i < runs.length; i++) {
      const current = runs[i];
      if (!current) continue;
      const previous = runs[i - 1];
      const next = runs[i + 1];

      const left = previous
        ? Math.max(0, (current.box.left - previous.box.right) / 2)
        : Math.min(MARGIN_REACH, Math.max(0, current.box.left - layerBox.left));
      const right = next
        ? Math.max(0, (next.box.left - current.box.right) / 2)
        : Math.min(
            MARGIN_REACH,
            Math.max(0, layerBox.right - current.box.right),
          );

      current.span.style.paddingInline = `${String(left)}px ${String(right)}px`;
      current.span.style.marginInline = `${String(-left)}px ${String(-right)}px`;
    }
  }
}

function widenTextLayerHitArea(): void {
  const style = document.createElement('style');
  style.id = 'oit-pdf-hit-area';
  style.textContent = HIT_AREA_STYLE;
  (document.head ?? document.documentElement).appendChild(style);

  // Pages render lazily and re-render on zoom, so this cannot be a one-off.
  const seen = new WeakSet<Element>();
  const sweep = (): void => {
    for (const layer of document.querySelectorAll('.textLayer')) {
      if (seen.has(layer) || layer.childElementCount === 0) continue;
      seen.add(layer);
      widenLineBoxes(layer);
    }
  };
  sweep();
  new MutationObserver(sweep).observe(document.body, {
    childList: true,
    subtree: true,
  });
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
    void (async () => {
      const settings = await loadSettings();
      await togglePdfTranslation(document, {
        targetLang: settings.targetLang,
        translate: (text, signal, onDownloadProgress) =>
          translateViaPort({
            text,
            targetLang: settings.targetLang,
            model: settings.modelId,
            signal,
            onDownloadProgress,
            // The viewer page is the extension's own document and says it is in
            // English; the paper inside it is whatever the author wrote.
            fromPageLanguage: false,
          }),
        shouldSkipText: (text) => shouldBypassAI(text, settings.targetLang),
      });
    })();
  });
});
