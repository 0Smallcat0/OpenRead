/**
 * Whole-page bilingual translation.
 *
 * Selection translation answers "what does this sentence say". This answers
 * "let me read this page", which is what most people mean when they install a
 * translator, and it is a different engineering problem: dozens of requests
 * instead of one, against a local server that is a single GPU rather than a
 * fleet, with the user watching.
 *
 * Three decisions shape everything here:
 *
 * **Bilingual, not replacement.** The translation is appended under each
 * block, never over it. A local 8B model is good, not perfect; leaving the
 * original in place means a suspicious sentence can be checked, and a bad
 * translation degrades the page instead of destroying it.
 *
 * **Bounded concurrency, document order.** Ollama serves one model request at
 * a time by default, so flooding it with fifty parallel requests only builds a
 * queue — and a queue in arrival order, which is not the order anyone reads
 * in. Two in flight keeps the server busy while the page fills from the top.
 *
 * **Every block is independent.** One failure marks one paragraph and the run
 * continues. A page is not all-or-nothing.
 */
import {
  collectBlocks,
  isElementVisible,
  TRANSLATED_ATTR,
  type CollectOptions,
} from './blocks';

export const BILINGUAL_CLASS = 'oit-bilingual';
export const PROGRESS_ID = 'oit-page-progress';
const STYLE_ID = 'oit-page-style';

/**
 * Two at a time. Ollama runs one generation per model by default, so the
 * second request is really a warm queue slot: it removes the gap between one
 * block finishing and the next arriving, without pretending the server is
 * parallel.
 */
export const CONCURRENCY = 2;

export interface PageTranslateDeps {
  /** Translate one block's text. Rejects on failure; aborts on the signal. */
  translate: (text: string, signal: AbortSignal) => Promise<string>;
  /** Target language, used for the `lang` attribute on inserted nodes. */
  targetLang: string;
  isVisible?: CollectOptions['isVisible'];
  shouldSkipText?: CollectOptions['shouldSkipText'];
}

export interface PageResult {
  translated: number;
  failed: number;
  /** True when the user stopped the run before it finished. */
  stopped: boolean;
}

let active: AbortController | null = null;

export function isPageTranslationRunning(): boolean {
  return active !== null;
}

/** Stop an in-flight run. Whatever landed already stays on the page. */
export function stopPageTranslation(): void {
  active?.abort();
  active = null;
}

/** Remove every inserted translation. Returns how many were removed. */
export function clearPageTranslation(root: ParentNode): number {
  const inserted = root.querySelectorAll(`.${BILINGUAL_CLASS}`);
  for (const node of Array.from(inserted)) node.remove();
  for (const marked of Array.from(
    root.querySelectorAll(`[${TRANSLATED_ATTR}]`),
  ))
    marked.removeAttribute(TRANSLATED_ATTR);
  return inserted.length;
}

export function isPageTranslated(root: ParentNode): boolean {
  return root.querySelector(`.${BILINGUAL_CLASS}`) !== null;
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // `currentColor` on purpose: the page's own text colour is the only value
  // guaranteed to be readable on the page's own background, on a light theme
  // or a dark one, and this extension has no business guessing either.
  style.textContent = `
.${BILINGUAL_CLASS} {
  display: block;
  margin-top: 0.35em;
  padding-left: 0.6em;
  border-left: 2px solid currentColor;
  opacity: 0.85;
  font-size: inherit;
  line-height: inherit;
  white-space: pre-wrap;
}
.${BILINGUAL_CLASS}[data-oit-failed] {
  opacity: 0.55;
  font-style: italic;
}
#${PROGRESS_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font: 500 13px/1.3 system-ui, -apple-system, sans-serif;
  color: #fff;
  background: #1f2937;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgb(0 0 0 / 0.25);
}
#${PROGRESS_ID} button {
  padding: 4px 10px;
  font: inherit;
  color: #fff;
  background: #374151;
  border: 1px solid #6b7280;
  border-radius: 5px;
  cursor: pointer;
}
#${PROGRESS_ID} button:hover {
  background: #4b5563;
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

interface Progress {
  update: (done: number, total: number) => void;
  finish: (message: string) => void;
}

function mountProgress(doc: Document, onStop: () => void): Progress {
  doc.getElementById(PROGRESS_ID)?.remove();
  const badge = doc.createElement('div');
  badge.id = PROGRESS_ID;
  // Announced, because a long run is exactly the case where a user without
  // sight of the corner of the screen needs to know something is happening.
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'polite');

  const label = doc.createElement('span');
  const stop = doc.createElement('button');
  stop.type = 'button';
  stop.textContent = 'Stop';
  stop.addEventListener('click', onStop);
  badge.append(label, stop);
  (doc.body ?? doc.documentElement).appendChild(badge);

  return {
    update: (done, total) => {
      label.textContent = `Translating ${String(done)}/${String(total)}`;
    },
    finish: (message) => {
      label.textContent = message;
      stop.remove();
      window.setTimeout(() => badge.remove(), 2500);
    },
  };
}

function attach(
  block: HTMLElement,
  text: string,
  targetLang: string,
  failed: boolean,
): void {
  const doc = block.ownerDocument;
  const node = doc.createElement('span');
  node.className = BILINGUAL_CLASS;
  // A span rather than a div: a div inside a `p` is invalid HTML, and while
  // the DOM API will not reject it, anything that later re-serialises the page
  // will move it out of the paragraph.
  node.lang = targetLang;
  node.setAttribute('dir', 'auto');
  if (failed) node.setAttribute('data-oit-failed', '');
  node.textContent = text;
  block.appendChild(node);
  block.setAttribute(TRANSLATED_ATTR, '');
}

/**
 * Translate every worthwhile block on the page, filling from the top.
 *
 * Resolves when the page is done, the user stopped it, or there was nothing to
 * do. Safe to call on an already-translated page: blocks carrying a
 * translation are skipped, so this also serves as "translate what has since
 * loaded".
 */
export async function translatePage(
  root: Document,
  deps: PageTranslateDeps,
): Promise<PageResult> {
  stopPageTranslation();
  const controller = new AbortController();
  active = controller;

  ensureStyle(root);

  const blocks = collectBlocks(root.body ?? root, {
    isVisible: deps.isVisible ?? isElementVisible,
    shouldSkipText: deps.shouldSkipText,
  });

  if (blocks.length === 0) {
    active = null;
    const progress = mountProgress(root, stopPageTranslation);
    progress.finish('Nothing to translate on this page');
    return { translated: 0, failed: 0, stopped: false };
  }

  const progress = mountProgress(root, stopPageTranslation);
  progress.update(0, blocks.length);

  let done = 0;
  let translated = 0;
  let failed = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = next++;
      const block = blocks[index];
      if (!block) return;

      // Text is read now rather than at collection time so a block that
      // changed while the queue drained is translated as it currently reads.
      const source = (block.textContent ?? '').trim();
      try {
        const result = await deps.translate(source, controller.signal);
        if (controller.signal.aborted) return;
        if (result.trim()) {
          attach(block, result.trim(), deps.targetLang, false);
          translated++;
        } else {
          // An empty generation is a failure with a friendly face: silently
          // skipping it leaves a gap the reader reads as "already translated".
          attach(block, '⚠️ no translation returned', deps.targetLang, true);
          failed++;
        }
      } catch {
        if (controller.signal.aborted) return;
        attach(block, '⚠️ translation failed', deps.targetLang, true);
        failed++;
      }
      done++;
      progress.update(done, blocks.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, () =>
      worker(),
    ),
  );

  const stopped = controller.signal.aborted;
  if (active === controller) active = null;

  progress.finish(
    stopped
      ? `Stopped — ${String(translated)} translated`
      : failed > 0
        ? `Done — ${String(translated)} translated, ${String(failed)} failed`
        : `Done — ${String(translated)} translated`,
  );

  return { translated, failed, stopped };
}

/**
 * The single entry point behind the toolbar button and the keyboard shortcut.
 *
 * One control, three meanings, in the order a user expects: running → stop,
 * translated → clear, otherwise → translate. A separate "undo" button would
 * spend permanent screen space on a state that is obvious from the page.
 */
export async function togglePageTranslation(
  root: Document,
  deps: PageTranslateDeps,
): Promise<PageResult | null> {
  if (isPageTranslationRunning()) {
    stopPageTranslation();
    return null;
  }
  if (isPageTranslated(root)) {
    clearPageTranslation(root);
    root.getElementById(PROGRESS_ID)?.remove();
    return null;
  }
  return translatePage(root, deps);
}
