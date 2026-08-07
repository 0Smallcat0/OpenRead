/**
 * Whole-document translation for the bundled PDF viewer.
 *
 * The refusal this replaces was right about the constraint and wrong about the
 * conclusion. A PDF text layer really is absolutely-positioned spans over a
 * rendered page, and inserting a translation under a line really would land it
 * on the next one. But the pages themselves are ordinary block elements
 * stacked in `#viewer`, so a translation placed *after a page* costs nothing
 * and reads in order: the page as the author laid it out, then that page in
 * the reader's language, then the next page.
 *
 * Which also matches how a paper is read. Nobody wants a two-column PDF
 * reflowed into one; they want to see the figure and read the argument.
 *
 * Pages render lazily — measured on the viewer's own sample, 14 pages with a
 * text layer on 2 of them — so this cannot be a single pass any more than
 * whole-page translation could. It follows the viewer: translate the pages
 * that have rendered near the reader, and pick up the rest as they arrive.
 */
import { collectPdfParagraphs, type PdfParagraph } from './pdf-blocks';
import { hasTranslatableText } from './blocks';
import { mountPageProgress, type Progress } from './fullpage';
import { toBcp47 } from '../core/bcp47';

/** Marks a page whose translation has been placed after it. */
export const PDF_TRANSLATED_ATTR = 'data-oit-pdf-translated';
export const PDF_TRANSLATION_CLASS = 'oit-pdf-translation';
const STYLE_ID = 'oit-pdf-translation-style';

/** How many pages at a time. Same reasoning as the page queue: see CONCURRENCY. */
const PAGE_CONCURRENCY = 1;

export interface PdfTranslateDeps {
  translate: (
    text: string,
    signal: AbortSignal,
    /**
     * Chrome fetching a language pack, 0-1.
     *
     * Not optional in spirit. A first PDF on a fresh profile sat at
     * "Translating 0/2" for minutes with nothing else said, because this path
     * never reported the download the page path had reported since 2.15.0 —
     * the same two minutes of silence, one surface over.
     */
    onDownloadProgress?: (loaded: number) => void,
  ) => Promise<string>;
  targetLang: string;
  /** Skip text already in the target language, as everywhere else. */
  shouldSkipText?: (text: string) => boolean;
}

export interface PdfResult {
  pages: number;
  paragraphs: number;
  stopped: boolean;
}

let active: AbortController | null = null;
let watcher: MutationObserver | null = null;

export function isPdfTranslationRunning(): boolean {
  return active !== null;
}

export function stopPdfTranslation(): void {
  active?.abort();
  active = null;
  watcher?.disconnect();
  watcher = null;
}

export function isPdfTranslated(doc: Document): boolean {
  return doc.querySelector(`.${PDF_TRANSLATION_CLASS}`) !== null;
}

/** Remove every inserted translation. Returns how many pages were cleared. */
export function clearPdfTranslation(doc: Document): number {
  stopPdfTranslation();
  const inserted = Array.from(
    doc.querySelectorAll(`.${PDF_TRANSLATION_CLASS}`),
  );
  for (const node of inserted) node.remove();
  for (const page of Array.from(
    doc.querySelectorAll(`[${PDF_TRANSLATED_ATTR}]`),
  )) {
    page.removeAttribute(PDF_TRANSLATED_ATTR);
  }
  return inserted.length;
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // Coloured like the viewer's own chrome rather than like the page, because it
  // is not part of the document: it is a reading aid sitting next to one.
  //
  // Its *width* comes from the page above it — set inline by `matchPageWidth`
  // and kept in step by a ResizeObserver. A width of its own read as a separate
  // document floating beside the paper rather than as part of it, and the
  // viewer's zoom pulled the two further apart with every step.
  style.textContent = `
.${PDF_TRANSLATION_CLASS} {
  margin: 0 auto 24px;
  padding: 16px 20px;
  /* The inline width set by matchPageWidth is the page's width, and padding
     has to fit inside it — content-box put 20px of this block over each edge
     of the paper it belongs to. */
  box-sizing: border-box;
  font: 15px/1.7 system-ui, -apple-system, sans-serif;
  color: #111;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 6px rgb(0 0 0 / 0.2);
  white-space: pre-wrap;
  /* Said outright rather than inherited. This block lives inside the viewer's
     own container, and a translation nobody can copy out is half a feature. */
  user-select: text;
  -webkit-user-select: text;
}
.${PDF_TRANSLATION_CLASS} p {
  /* The block matches the page so it reads as part of the document; the text
     inside it does not, because a page of a paper is far wider than a readable
     line. At the page's full width this ran to about 130 characters a line and
     the result was a wall — reported as "everything is crammed together". */
  max-width: 34em;
  margin: 0 auto 0.9em;
}
.${PDF_TRANSLATION_CLASS} p:last-child {
  margin-bottom: 0;
}
/* Selection has to be given a colour back. The vendored viewer carries an
   OpenRead patch setting a global transparent ::selection, re-enabled only
   inside .textLayer, so the text layer and the canvas under it do not both
   render the highlight. This panel is neither, so selecting it highlighted
   nothing — the text was selected the whole time and only looked as though it
   was not. Reported as "I cannot select the translation". */
.${PDF_TRANSLATION_CLASS}::selection,
.${PDF_TRANSLATION_CLASS} ::selection {
  background: rgba(0, 100, 255, 0.35);
  color: inherit;
}
@media (prefers-color-scheme: dark) {
  .${PDF_TRANSLATION_CLASS} {
    color: #e8e8e8;
    background: #2a2a2a;
  }
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Pages the viewer has actually rendered text for. */
function renderedPages(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>('.page')).filter(
    (page) =>
      !page.hasAttribute(PDF_TRANSLATED_ATTR) &&
      (page.querySelector('.textLayer')?.childElementCount ?? 0) > 0,
  );
}

/** Nearest first, so the reader's page is translated before page fourteen. */
function byDistanceFromViewport(
  doc: Document,
  pages: HTMLElement[],
): HTMLElement[] {
  const middle = (doc.defaultView?.innerHeight ?? 0) / 2;
  return [...pages].sort((a, b) => {
    const da = Math.abs(a.getBoundingClientRect().top - middle);
    const db = Math.abs(b.getBoundingClientRect().top - middle);
    return da - db;
  });
}

/**
 * Keep the panel exactly as wide as the page it belongs to.
 *
 * The viewer centres pages and rescales them on zoom, so a panel with a width
 * of its own drifts out of line with the paper the moment anything changes.
 * Reported from use: "the translation is not aligned with the text".
 */
function matchPageWidth(page: HTMLElement, block: HTMLElement): void {
  const apply = (): void => {
    block.style.width = `${String(page.getBoundingClientRect().width)}px`;
  };
  apply();
  const view = page.ownerDocument.defaultView;
  if (typeof view?.ResizeObserver === 'function') {
    new view.ResizeObserver(apply).observe(page);
  }
}

function attachPage(
  page: HTMLElement,
  translations: string[],
  targetLang: string,
): void {
  const doc = page.ownerDocument;
  const block = doc.createElement('div');
  block.className = PDF_TRANSLATION_CLASS;
  const tag = toBcp47(targetLang);
  if (tag) block.lang = tag;
  block.setAttribute('dir', 'auto');
  for (const text of translations) {
    const paragraph = doc.createElement('p');
    paragraph.textContent = text;
    block.appendChild(paragraph);
  }
  page.after(block);
  matchPageWidth(page, block);
  page.setAttribute(PDF_TRANSLATED_ATTR, '');
}

/** Translate one page's paragraphs, in order, and place them after it. */
async function translatePdfPage(
  page: HTMLElement,
  deps: PdfTranslateDeps,
  signal: AbortSignal,
  onDownloadProgress?: (loaded: number) => void,
  /**
   * Called as each paragraph lands, not each page.
   *
   * The badge is shared with the language-pack download, and it only changed
   * back to a count when a whole page finished. A page of a paper is twenty
   * paragraphs, so after the pack arrived the badge sat on "Downloading
   * language pack 100%" for as long as the first page took — reported from use
   * as stuck at 100%, which is exactly what it looked like.
   */
  onParagraph?: () => void,
): Promise<number> {
  const layer = page.querySelector('.textLayer');
  if (!layer) return 0;
  const paragraphs = collectPdfParagraphs(layer).filter(
    (paragraph: PdfParagraph) =>
      hasTranslatableText(paragraph.text) &&
      !deps.shouldSkipText?.(paragraph.text),
  );
  if (paragraphs.length === 0) {
    // Marked anyway: a page of figures has nothing to translate and asking
    // again every time it scrolls back into view is pure cost.
    page.setAttribute(PDF_TRANSLATED_ATTR, '');
    return 0;
  }

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (signal.aborted) return 0;
    try {
      const result = (
        await deps.translate(paragraph.text, signal, onDownloadProgress)
      ).trim();
      // Unchanged means already in the target language; printing it would
      // repeat the page in the panel under it.
      if (result && result !== paragraph.text) out.push(result);
      onParagraph?.();
    } catch {
      // One paragraph of a page, on a document that may be hundreds. The page
      // is still worth placing; a gap is better than an error per line.
    }
  }
  if (signal.aborted || out.length === 0) {
    page.setAttribute(PDF_TRANSLATED_ATTR, '');
    return 0;
  }
  attachPage(page, out, deps.targetLang);
  return out.length;
}

/**
 * Translate the document, following the viewer as it renders.
 *
 * Resolves once the pages rendered right now are done. The observer stays
 * attached, so scrolling into a page the viewer had not drawn yet translates
 * it without another press — the same bargain whole-page translation makes.
 */
export async function translatePdf(
  doc: Document,
  deps: PdfTranslateDeps,
): Promise<PdfResult> {
  stopPdfTranslation();
  ensureStyle(doc);
  const controller = new AbortController();
  active = controller;

  const progress: Progress = mountPageProgress(doc, stopPdfTranslation);
  let pages = 0;
  let paragraphs = 0;
  let queued = renderedPages(doc);
  progress.update(0, queued.length);

  const drain = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const next = byDistanceFromViewport(doc, queued).shift();
      if (!next) break;
      queued = queued.filter((page) => page !== next);
      const done = await translatePdfPage(
        next,
        deps,
        controller.signal,
        (l) => progress.downloading(l),
        () => progress.update(pages, pages + queued.length + 1),
      );
      if (controller.signal.aborted) return;
      paragraphs += done;
      pages++;
      progress.update(pages, pages + queued.length);
      if (queued.length === 0) queued = renderedPages(doc);
    }
  };

  // A MutationObserver rather than an interval: the viewer builds a text layer
  // when it draws a page, and that is a DOM change we can be told about.
  watcher = new doc.defaultView!.MutationObserver(() => {
    if (controller.signal.aborted) return;
    const fresh = renderedPages(doc).filter((page) => !queued.includes(page));
    if (fresh.length > 0) queued.push(...fresh);
  });
  const viewer = doc.getElementById('viewer') ?? doc.body;
  watcher.observe(viewer, { childList: true, subtree: true });

  await Promise.all(
    Array.from(
      { length: Math.min(PAGE_CONCURRENCY, Math.max(queued.length, 1)) },
      () => drain(),
    ),
  );

  const stopped = controller.signal.aborted;
  if (active === controller) active = null;
  progress.finish(
    stopped
      ? `Stopped — ${String(pages)} pages translated`
      : pages === 0
        ? 'Nothing to translate in this document'
        : `Done — ${String(pages)} pages translated`,
  );
  return { pages, paragraphs, stopped };
}

/** One control, the same three meanings the web page's button has. */
export async function togglePdfTranslation(
  doc: Document,
  deps: PdfTranslateDeps,
): Promise<PdfResult | null> {
  if (isPdfTranslationRunning()) {
    stopPdfTranslation();
    return null;
  }
  if (isPdfTranslated(doc)) {
    clearPdfTranslation(doc);
    return null;
  }
  return translatePdf(doc, deps);
}
