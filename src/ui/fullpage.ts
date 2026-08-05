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
  visibleText,
  TRANSLATED_ATTR,
  type CollectOptions,
} from './blocks';
import { toBcp47 } from '../core/bcp47';

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
  /**
   * Translate one block's text. Rejects on failure; aborts on the signal.
   *
   * `attempt` is 0 for the first try. The broker raises temperature above
   * that, which is what turns a model that returned nothing into one that
   * returns something.
   */
  translate: (
    text: string,
    signal: AbortSignal,
    attempt: number,
    /** Report a language-pack download, 0-1, so the badge can say so. */
    onDownloadProgress?: (loaded: number) => void,
  ) => Promise<string>;
  /**
   * Target language, as the human-readable name the rest of the project passes
   * around. Mapped to BCP-47 before it reaches the `lang` attribute — see
   * `attach`.
   */
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

/**
 * Say something in the corner, in the same place progress appears.
 *
 * Used where whole-page translation cannot run at all: the bundled PDF viewer
 * offers the action through the context menu like any other page, and doing
 * nothing there is the worst of the three options — worse than refusing, and
 * worse than not offering.
 */
export function showPageNotice(doc: Document, message: string): void {
  ensureStyle(doc);
  const progress = mountProgress(doc, () => undefined);
  progress.finish(message);
}

interface Progress {
  update: (done: number, total: number) => void;
  downloading: (loaded: number) => void;
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
    downloading: (loaded) => {
      // The one-time language-pack fetch. Around two minutes, and the reason
      // switching target language used to look like the extension breaking.
      label.textContent = `Downloading language pack ${String(
        Math.round(loaded * 100),
      )}%`;
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
  //
  // `lang` has to be BCP-47, and this used to set the dropdown's display name
  // straight onto the attribute: `lang="Traditional Chinese"`, which
  // `Intl.getCanonicalLocales` rejects outright. An invalid tag is not a
  // cosmetic problem — marking the language is what makes a screen reader read
  // the translation in a Chinese voice instead of spelling it out in an
  // English one, and an unparseable value means it falls back to the page's
  // own `lang`. Omitted entirely when the name maps to nothing, because no tag
  // at least inherits, while a wrong one asserts.
  const tag = toBcp47(targetLang);
  if (tag) node.lang = tag;
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
  /**
   * The first real reason a block failed.
   *
   * The broker already produces something a user can act on — "Can't reach
   * Ollama at http://…. Is the server running?" — and the selection panel
   * shows it. This path used to throw it away and print "translation failed"
   * once per block: twenty-eight identical lines, none of them saying what to
   * do. Kept once and shown in the summary, which is the one place it is
   * worth reading.
   */
  let firstError: string | null = null;

  // `limit` exists for the ramp-up below. Without it the first `await
  // worker()` drains the entire queue on its own and the run is sequential.
  const worker = async (limit = Infinity): Promise<void> => {
    let handled = 0;
    while (!controller.signal.aborted && handled < limit) {
      const index = next++;
      const block = blocks[index];
      if (!block) return;

      // Read now rather than at collection time, so a block that changed
      // while the queue drained is translated as it currently reads — and
      // through `visibleText`, so a stylesheet child is never sent to a model.
      const source = visibleText(block).trim();
      try {
        let result = await deps.translate(source, controller.signal, 0, (l) =>
          progress.downloading(l),
        );
        // One retry on an empty generation, which the selection path has
        // always done and this one never did. The broker raises temperature on
        // the second attempt, so it is a different sample rather than the same
        // request hopefully going better.
        if (!result.trim() && !controller.signal.aborted) {
          result = await deps.translate(source, controller.signal, 1);
        }
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
      } catch (error) {
        if (controller.signal.aborted) return;
        const reason =
          error instanceof Error ? error.message.trim() : String(error);
        if (!firstError && reason) firstError = reason;
        attach(block, '⚠️ translation failed', deps.targetLang, true);
        failed++;
      }
      done++;
      handled++;
      progress.update(done, blocks.length);
    }
  };

  // Ramp up rather than opening at full width.
  //
  // The first request to a cold Ollama waits for the model to load into VRAM —
  // measured at ~5 s here — and a second request racing it does not arrive any
  // sooner, it only makes the queue longer while the same load happens. Worse,
  // the cold burst is where failures cluster: 9 of 45 blocks on the first run
  // of a real article, 1 of 45 once warm.
  //
  // So the first block runs alone. By the time it returns the model is
  // resident, and the rest of the queue opens at full concurrency against a
  // warm server. Costs nothing when the model was already loaded.
  await worker(1);

  if (!controller.signal.aborted && next < blocks.length) {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, blocks.length - next) }, () =>
        worker(),
      ),
    );
  }

  const stopped = controller.signal.aborted;
  if (active === controller) active = null;

  const summary = stopped
    ? `Stopped — ${String(translated)} translated`
    : failed > 0
      ? `Done — ${String(translated)} translated, ${String(failed)} failed`
      : `Done — ${String(translated)} translated`;
  progress.finish(
    failed > 0 && firstError ? `${summary} — ${firstError}` : summary,
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
