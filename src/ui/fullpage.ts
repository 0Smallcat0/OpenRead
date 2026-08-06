/**
 * Whole-page bilingual translation.
 *
 * Selection translation answers "what does this sentence say". This answers
 * "let me read this page", which is what most people mean when they install a
 * translator, and it is a different engineering problem: dozens of requests
 * instead of one, against a local server that is a single GPU rather than a
 * fleet, with the user watching.
 *
 * Four decisions shape everything here:
 *
 * **Bilingual, not replacement.** The translation is appended under each
 * block, never over it. A local 8B model is good, not perfect; leaving the
 * original in place means a suspicious sentence can be checked, and a bad
 * translation degrades the page instead of destroying it.
 *
 * **Bounded concurrency, reading order.** Ollama serves one model request at
 * a time by default, so flooding it with fifty parallel requests only builds a
 * queue — and a queue in arrival order, which is not the order anyone reads
 * in. Two in flight keeps the server busy while the page fills from the top.
 *
 * **Every block is independent.** One failure marks one paragraph and the run
 * continues. A page is not all-or-nothing.
 *
 * **Translate a block when it becomes relevant, not when it is found.** The
 * English Wikipedia article on artificial intelligence has 308 translatable
 * blocks and shows about five of them; translating all 308 up front spends the
 * reader's battery on text they will never scroll to, and still misses every
 * word that loads afterwards — which on an infinite feed is most of the page.
 * So the queue is live: it starts with what is near the viewport, an
 * IntersectionObserver feeds it the rest as the reader arrives, and a
 * MutationObserver feeds it whatever the page adds later.
 */
import {
  collectBlocks,
  isElementVisible,
  visibleText,
  queryDeep,
  TRANSLATED_ATTR,
  BILINGUAL_CLASS,
  OWN_UI,
  type CollectOptions,
} from './blocks';
import { toBcp47 } from '../core/bcp47';
import type {
  DisplayMode,
  TranslationStyle,
  TranslationScale,
} from '../settings';

// Defined next to the collector, which needs it to tell a live marker from a
// stale one; re-exported here because this is where callers import it from.
export { BILINGUAL_CLASS };
export const PROGRESS_ID = 'oit-page-progress';

/**
 * Wraps a block's own text once a translation sits beside it.
 *
 * Only inserted in translation-only mode, where something has to be hidden and
 * a block's text nodes cannot be hidden without hiding its children too.
 * Removing it puts the nodes back exactly where they were, so undo is still
 * byte for byte.
 */
export const ORIGINAL_CLASS = 'oit-original';
const STYLE_ID = 'oit-page-style';

/**
 * Two at a time.
 *
 * Ollama runs one generation per model by default, so the second request is
 * really a warm queue slot: it removes the gap between one block finishing and
 * the next arriving, without pretending the server is parallel.
 *
 * Chrome's built-in translator does not want more either — measured across 1,
 * 2, 4 and 8 in flight, total wall time varied by 3% while per-block latency
 * doubled at each level, because the API serialises internally and the extra
 * requests only queue. Two is right for both engines, for opposite reasons.
 */
export const CONCURRENCY = 2;

/**
 * Consecutive failures that end the run.
 *
 * Three, because one block failing on its own is bad luck and three in a row is
 * a setup that is not going to start working on block four. The old behaviour
 * marked every block: with Ollama not running, twenty-eight ⚠️ lines for one
 * problem that was obvious by the third, all of which the reader then had to
 * clear.
 */
export const GIVE_UP_AFTER = 3;

/**
 * How far beyond the viewport counts as "about to be read", as a multiple of
 * the window height, in both directions.
 *
 * One screen: far enough that scrolling at a normal pace meets finished text
 * rather than a translation arriving under the eye, close enough that a long
 * article still only translates a fraction of itself.
 */
export const VIEWPORT_MARGIN_SCREENS = 1;

/**
 * How long to wait after the page changes before looking for new blocks.
 *
 * A React render, a feed appending ten posts, or our own insertion each arrive
 * as a burst of mutation records; collecting on every one of them would run the
 * collector hundreds of times a second. Collecting is ~37 ms on a very large
 * page, so the window has to be long enough to coalesce a burst and short
 * enough that new text does not visibly sit untranslated.
 */
const RESCAN_DEBOUNCE_MS = 300;

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
  /** How the result should look. Defaults to bilingual in the current style. */
  appearance?: Appearance;
  /**
   * True when nobody pressed anything — an automatic pass on page load.
   *
   * Only changes what is said about an empty page. A press that appears to do
   * nothing looks broken, so it is answered; an automatic pass that finds
   * nothing has nothing to report, and on an app that renders after load it
   * would find nothing on every single navigation. The observers are attached
   * either way, so "nothing yet" still becomes "translated" on its own.
   */
  unprompted?: boolean;
}

/** The three things a reader can change about how a translation looks. */
export interface Appearance {
  displayMode: DisplayMode;
  translationStyle: TranslationStyle;
  translationScale: TranslationScale;
}

const DEFAULT_APPEARANCE: Appearance = {
  displayMode: 'bilingual',
  translationStyle: 'line',
  translationScale: 'same',
};

/**
 * Put the appearance on the document, where CSS can act on it.
 *
 * Attributes rather than inline styles on every inserted node: one write
 * restyles a page of five hundred translations, which is what makes changing
 * the setting feel immediate instead of requiring a re-run.
 */
export function applyAppearance(root: Document, appearance: Appearance): void {
  const element = root.documentElement;
  if (!element) return;
  element.setAttribute('data-oit-display', appearance.displayMode);
  element.setAttribute('data-oit-style', appearance.translationStyle);
  element.setAttribute('data-oit-scale', appearance.translationScale);
}

/**
 * Move a block's own content into `.oit-original`, or put it back.
 *
 * Wrapping is confined to translation-only mode. It moves nodes, and moving
 * nodes on a live page is a thing to do as little of as possible: a script
 * holding a reference to a paragraph's first child is not wrong to expect it to
 * still be a child of that paragraph.
 */
function wrapOriginal(block: HTMLElement): void {
  if (block.querySelector(`:scope > .${ORIGINAL_CLASS}`)) return;
  const doc = block.ownerDocument;
  const holder = doc.createElement('span');
  holder.className = ORIGINAL_CLASS;
  while (block.firstChild) holder.appendChild(block.firstChild);
  block.appendChild(holder);
}

function unwrapOriginal(holder: Element): void {
  const parent = holder.parentNode;
  if (!parent) return;
  while (holder.firstChild) parent.insertBefore(holder.firstChild, holder);
  holder.remove();
}

/**
 * Switch an already-translated page between bilingual and translation-only.
 *
 * The style and the size are pure CSS and change with the attribute alone.
 * This one cannot be: the wrapper only exists where it is needed, so turning
 * the mode on has to create it and turning it off has to take it away.
 */
export function reflowTranslations(root: Document, mode: DisplayMode): void {
  if (mode === 'translationOnly') {
    for (const block of queryDeep<HTMLElement>(root, `[${TRANSLATED_ATTR}]`)) {
      wrapOriginal(block);
    }
    return;
  }
  for (const holder of queryDeep(root, `.${ORIGINAL_CLASS}`)) {
    unwrapOriginal(holder);
  }
}

export interface PageResult {
  translated: number;
  failed: number;
  /**
   * Blocks the engine returned unchanged, so nothing was inserted for them.
   * Asked for a language the text is already in, both engines hand it back
   * verbatim; a page of those is a page that needed no translating.
   */
  unchanged: number;
  /** True when the user stopped the run before it finished. */
  stopped: boolean;
}

/**
 * A batch being translated right now.
 *
 * Its `queue` is live: the observers below push into it while it drains, so a
 * reader who scrolls during a run does not wait for the run to end before the
 * text they just reached is picked up.
 */
interface Run {
  controller: AbortController;
  queue: HTMLElement[];
  inFlight: number;
  done: number;
  /** Nobody pressed anything to start this one. See `togglePageTranslation`. */
  unprompted: boolean;
}

/**
 * What keeps a page translated after the first batch.
 *
 * Outlives a run on purpose — a run ends when its queue drains, and the whole
 * point of this is that the queue fills again.
 */
interface Watch {
  root: Document;
  deps: PageTranslateDeps;
  intersection: IntersectionObserver | null;
  mutation: MutationObserver | null;
  rescan: ReturnType<typeof setTimeout> | null;
  /** Off-screen blocks handed to the IntersectionObserver, awaiting arrival. */
  deferred: Set<HTMLElement>;
  /**
   * Blocks that have already been handed to a queue, so a rescan does not hand
   * them over a second time.
   *
   * Two ways that goes wrong without it, both of them found in testing. A
   * rescan that lands mid-run re-collects every block still waiting its turn —
   * they are untranslated, because they have not been reached yet — and the
   * page gets each of them twice. And a block the engine returns unchanged is
   * deliberately left unmarked so a later run can retry it, which means every
   * rescan forever collects it again: one page of proper nouns, one infinite
   * loop.
   *
   * Weak, because the page owns these nodes and a feed that trims what
   * scrolled past should be able to drop them.
   */
  claimed: WeakSet<HTMLElement>;
  /** Became relevant while no run was active. */
  pending: HTMLElement[];
  /** Scheduled follow-up run, so a burst of arrivals starts one, not ten. */
  soon: ReturnType<typeof setTimeout> | null;
}

let run: Run | null = null;
let watch: Watch | null = null;

/**
 * True only while blocks are actually being translated.
 *
 * Deliberately not "is this page being watched": watching is the steady state
 * of a translated page, and if it counted as running then the toolbar button
 * would mean "stop" forever and never mean "undo".
 */
export function isPageTranslationRunning(): boolean {
  return run !== null;
}

/**
 * Stop translating, and stop watching for more.
 *
 * Whatever landed already stays on the page. Both halves matter: a user who
 * presses Stop and then keeps scrolling has said no, and observers that
 * survived would answer by translating the next screen.
 */
export function stopPageTranslation(): void {
  run?.controller.abort();
  run = null;
  stopWatching();
}

function stopWatching(): void {
  if (!watch) return;
  watch.intersection?.disconnect();
  watch.mutation?.disconnect();
  if (watch.rescan !== null) clearTimeout(watch.rescan);
  if (watch.soon !== null) clearTimeout(watch.soon);
  watch = null;
}

/** Remove every inserted translation. Returns how many were removed. */
export function clearPageTranslation(root: ParentNode): number {
  // Clearing is the undo half of the toolbar button, so it has to take the
  // watchers with it. Left running, they would read the removals as the page
  // changing and translate it straight back.
  stopPageTranslation();
  // Deep, because blocks can come from inside a web component and a
  // translation left behind there is one the toggle can never remove.
  const inserted = queryDeep(root, `.${BILINGUAL_CLASS}`);
  for (const node of inserted) node.remove();
  // The wrapper goes back to being the block's own children, in order, so undo
  // restores the page rather than leaving a span nobody asked for.
  for (const holder of queryDeep(root, `.${ORIGINAL_CLASS}`))
    unwrapOriginal(holder);
  for (const marked of queryDeep(root, `[${TRANSLATED_ATTR}]`))
    marked.removeAttribute(TRANSLATED_ATTR);
  return inserted.length;
}

export function isPageTranslated(root: ParentNode): boolean {
  return queryDeep(root, `.${BILINGUAL_CLASS}`).length > 0;
}

/**
 * Whether what is on the page is a translation into `targetLang`.
 *
 * Every inserted node carries the target as a BCP-47 `lang`, so the page keeps
 * a record of which language it was translated into and the toggle can tell a
 * stale translation from a current one.
 *
 * Returns true when it cannot tell — an unmapped target, or nodes left by a
 * version that wrote no `lang` — because "unknown" must not be read as "wrong"
 * and silently retranslate a page the user asked to have cleared.
 */
export function isTranslatedInto(
  root: ParentNode,
  targetLang: string,
): boolean {
  const tag = toBcp47(targetLang);
  if (!tag) return true;
  const inserted = queryDeep<HTMLElement>(root, `.${BILINGUAL_CLASS}`);
  return inserted.every((node) => {
    const lang = node.getAttribute('lang');
    return !lang || lang === tag;
  });
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
/* Translation only. The original is still there, and one attribute brings it
   back — which is what makes the setting worth having rather than a re-run. */
:root[data-oit-display='translationOnly'] .${ORIGINAL_CLASS} {
  display: none;
}
:root[data-oit-display='translationOnly'] .${BILINGUAL_CLASS} {
  margin-top: 0;
  opacity: 1;
}
/* Marked out four ways, because the line that reads as a quiet aside on one
   site reads as a blockquote on another. */
:root[data-oit-style='plain'] .${BILINGUAL_CLASS} {
  padding-left: 0;
  border-left: 0;
}
:root[data-oit-style='dashed'] .${BILINGUAL_CLASS} {
  padding-left: 0;
  border-left: 0;
  border-bottom: 1px dashed currentColor;
}
:root[data-oit-style='highlight'] .${BILINGUAL_CLASS} {
  padding: 0.1em 0.35em;
  border-left: 0;
  /* currentColor at low alpha, so it tints whatever the page's own background
     is instead of asserting a colour of its own. */
  background: color-mix(in srgb, currentColor 10%, transparent);
}
:root[data-oit-scale='small'] .${BILINGUAL_CLASS} {
  font-size: 0.88em;
}
:root[data-oit-scale='large'] .${BILINGUAL_CLASS} {
  font-size: 1.12em;
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

export interface Progress {
  update: (done: number, total: number) => void;
  downloading: (loaded: number) => void;
  finish: (message: string) => void;
}

/**
 * The corner badge, for a caller that is not this file.
 *
 * Exported for the PDF viewer, which runs a different kind of pass over a
 * different kind of document and should still count progress and offer Stop in
 * the same place, looking the same, with the same screen-reader announcement.
 */
export function mountPageProgress(doc: Document, onStop: () => void): Progress {
  ensureStyle(doc);
  return mountProgress(doc, onStop);
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
      //
      // The percentage is dropped while it is still zero, because the monitor's
      // granularity is not something a caller can rely on: measured at 479
      // events for `en`→`zh-Hant` and exactly two — 0 then 1 — for `en`→`ko`,
      // which took 81 seconds. "0%" held for a minute and a half reads as
      // stuck, and stuck is the impression this line exists to prevent.
      const percent = Math.round(loaded * 100);
      label.textContent =
        percent > 0
          ? `Downloading language pack ${String(percent)}%`
          : 'Downloading language pack…';
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
  displayMode: DisplayMode = 'bilingual',
): void {
  const doc = block.ownerDocument;
  if (displayMode === 'translationOnly') wrapOriginal(block);
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
 * Translate one block, on its own, and attach the result.
 *
 * The unit behind pointing at a paragraph. It shares `attach` and the
 * appearance with a whole-page run on purpose: a paragraph translated this way
 * has to be indistinguishable from the same paragraph translated by a run, or
 * undo and re-translate would have to know which was which.
 *
 * Resolves false when there was nothing to do — already translated, gone from
 * the page, nothing worth a round trip, or the engine handing the text back.
 */
export async function translateBlock(
  block: HTMLElement,
  deps: PageTranslateDeps,
): Promise<boolean> {
  if (!block.isConnected || block.hasAttribute(TRANSLATED_ATTR)) return false;
  const source = visibleText(block).trim();
  if (!source) return false;
  if (deps.shouldSkipText?.(source)) return false;

  const appearance = deps.appearance ?? DEFAULT_APPEARANCE;
  applyAppearance(block.ownerDocument, appearance);
  ensureStyle(block.ownerDocument);

  const controller = new AbortController();
  try {
    const result = await deps.translate(source, controller.signal, 0);
    const trimmed = result.trim();
    // Handed back unchanged means the block is already in the target language,
    // and inserting it would print the paragraph twice.
    if (!trimmed || trimmed === source) return false;
    if (!block.isConnected || block.hasAttribute(TRANSLATED_ATTR)) return false;
    attach(block, trimmed, deps.targetLang, false, appearance.displayMode);
    return true;
  } catch {
    // Silent on purpose. A whole-page run reports failures in a badge the
    // reader asked for; one paragraph that did not come back is not worth
    // marking the page over, and the gesture can simply be repeated.
    return false;
  }
}

/**
 * Is this block near enough to the viewport to be worth translating now?
 *
 * A rect test rather than waiting on the IntersectionObserver's first callback:
 * that callback is asynchronous, so a run started from it would begin with an
 * empty queue and report a finished page before it had looked at one. Measured
 * at 5 ms across 2,998 candidates, which is not worth deferring.
 *
 * In jsdom every rect is zero and every block therefore counts as near, which
 * is the honest answer for a document with no layout — and it keeps the whole
 * of this file testable without a browser.
 */
function nearViewport(block: HTMLElement): boolean {
  const view = block.ownerDocument.defaultView;
  if (!view) return true;
  const height = view.innerHeight || 0;
  const margin = height * VIEWPORT_MARGIN_SCREENS;
  const rect = block.getBoundingClientRect();
  return rect.top < height + margin && rect.bottom > -margin;
}

/** Document order, so a batch that arrives at once is still read top to bottom. */
function inReadingOrder(blocks: HTMLElement[]): HTMLElement[] {
  return blocks.sort((a, b) =>
    // 4 = DOCUMENT_POSITION_FOLLOWING: b comes after a.
    a.compareDocumentPosition(b) & 4 ? -1 : 1,
  );
}

/**
 * Hand blocks to the translator: straight into a running batch if there is
 * one, otherwise into a batch started shortly.
 *
 * "Shortly" rather than "now" because arrivals cluster — one scroll crosses ten
 * paragraphs at once, and each would otherwise start its own batch, its own
 * badge and its own ramp-up.
 */
function offer(blocks: HTMLElement[]): void {
  const state = watch;
  if (blocks.length === 0 || !state) return;
  const ordered = claim(inReadingOrder(blocks));
  if (ordered.length === 0) return;
  if (run) {
    run.queue.push(...ordered);
    return;
  }
  state.pending.push(...ordered);
  if (state.soon !== null) return;
  state.soon = setTimeout(() => {
    if (watch !== state) return;
    state.soon = null;
    const next = state.pending;
    state.pending = [];
    if (next.length > 0) void drainQueue(state.root, state.deps, next);
  }, RESCAN_DEBOUNCE_MS);
}

/**
 * Split freshly collected blocks into "translate now" and "translate when the
 * reader gets there", registering the second half with the observer.
 *
 * Without an IntersectionObserver — jsdom, and any environment old enough to
 * lack it — everything counts as now, which is what this did before and is
 * still the right fallback: translating too much is worse than translating too
 * little, but not as bad as translating nothing.
 */
function triage(blocks: HTMLElement[]): HTMLElement[] {
  const state = watch;
  if (!state) return blocks;
  const fresh = blocks.filter((block) => !state.claimed.has(block));
  if (!state.intersection) return fresh;
  const now: HTMLElement[] = [];
  for (const block of fresh) {
    if (nearViewport(block)) {
      now.push(block);
    } else if (!state.deferred.has(block)) {
      state.deferred.add(block);
      state.intersection.observe(block);
    }
  }
  return now;
}

/** Take ownership of blocks about to be queued, and drop any already owned. */
function claim(blocks: HTMLElement[]): HTMLElement[] {
  const state = watch;
  if (!state) return blocks;
  const mine: HTMLElement[] = [];
  for (const block of blocks) {
    if (state.claimed.has(block)) continue;
    state.claimed.add(block);
    mine.push(block);
  }
  return mine;
}

/**
 * Did we cause this mutation ourselves?
 *
 * Every translation is a mutation, and so is every tick of the progress
 * counter, so answering them would run the collector once per translated block
 * — and the badge's own label is a text node, which an "is it an element with
 * our class" test waves straight through.
 */
function isOurs(record: MutationRecord): boolean {
  const target = record.target;
  const scope =
    target.nodeType === 1 ? (target as Element) : target.parentElement;
  // `<head>` is watched only because the observer sits on `documentElement` —
  // see `startWatching`. A page loading a stylesheet or a script has not grown
  // anything to translate, and busy sites rewrite head constantly.
  if (scope?.closest('head')) return true;
  if (scope?.closest(OWN_UI)) return true;
  const touched = [
    ...Array.from(record.addedNodes),
    ...Array.from(record.removedNodes),
  ];
  return (
    touched.length > 0 &&
    touched.every(
      (node) =>
        // 1 = ELEMENT_NODE. `closest` includes the element itself, and works on
        // a node already detached from the document, which is what a removed
        // badge is by the time we see the record.
        node.nodeType === 1 && (node as Element).closest(OWN_UI),
    )
  );
}

function collect(root: Document, deps: PageTranslateDeps): HTMLElement[] {
  return collectBlocks(root.body ?? root, {
    isVisible: deps.isVisible ?? isElementVisible,
    shouldSkipText: deps.shouldSkipText,
  });
}

/**
 * Watch the page for work that does not exist yet.
 *
 * Two sources, one queue. The IntersectionObserver answers "the reader has
 * scrolled to a block we skipped"; the MutationObserver answers "the page grew
 * a block nobody had seen" — a feed appending posts, a comment thread
 * expanding, an SPA swapping a route. Before this, both cases needed the user
 * to press translate again, which on an infinite feed is a keypress per screen.
 */
function startWatching(root: Document, deps: PageTranslateDeps): void {
  stopWatching();
  const view = root.defaultView;
  if (!view) return;

  const state: Watch = {
    root,
    deps,
    intersection: null,
    mutation: null,
    rescan: null,
    deferred: new Set(),
    claimed: new WeakSet(),
    pending: [],
    soon: null,
  };
  watch = state;

  if (typeof view.IntersectionObserver === 'function') {
    state.intersection = new view.IntersectionObserver(
      (entries) => {
        const arrived: HTMLElement[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const block = entry.target as HTMLElement;
          // Unobserved on arrival, not on translation: from here the block is
          // in a queue, and an observer still watching it would offer it again
          // on the next scroll that recrosses the margin.
          state.intersection?.unobserve(block);
          state.deferred.delete(block);
          if (!block.hasAttribute(TRANSLATED_ATTR)) arrived.push(block);
        }
        offer(arrived);
      },
      { rootMargin: `${String(VIEWPORT_MARGIN_SCREENS * 100)}% 0px` },
    );
  }

  if (typeof view.MutationObserver === 'function') {
    state.mutation = new view.MutationObserver((records) => {
      if (records.every(isOurs)) return;
      if (state.rescan !== null) clearTimeout(state.rescan);
      state.rescan = setTimeout(() => {
        if (watch !== state) return;
        state.rescan = null;
        // Blocks the page has thrown away since we deferred them. Held in a
        // plain Set, because the IntersectionObserver has to be handed the same
        // node to unobserve it — so on a feed that trims what scrolled past,
        // this is the one place detached nodes would accumulate for the life of
        // the tab.
        for (const block of state.deferred) {
          if (!block.isConnected) {
            state.intersection?.unobserve(block);
            state.deferred.delete(block);
          }
        }
        offer(triage(collect(root, deps)));
      }, RESCAN_DEBOUNCE_MS);
    });
    // `documentElement`, not `body`. A single-page app that swaps routes by
    // replacing the whole `<body>` leaves an observer on the old one, watching
    // a node no longer in the document — measured: route A translated, route B
    // untouched, and no amount of scrolling brought it back. `documentElement`
    // survives everything short of a navigation, which ends the content script
    // anyway.
    state.mutation.observe(root.documentElement ?? root.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
}

/**
 * Translate every worthwhile block on the page, starting with what the reader
 * can see and continuing as they scroll.
 *
 * Resolves when the queue drains — which is the visible work, not the whole
 * document. The observers stay attached afterwards, so scrolling, and anything
 * the page loads later, are picked up without another press.
 *
 * Safe to call on an already-translated page: blocks carrying a translation are
 * skipped, so this also serves as "translate what has since loaded".
 */
export async function translatePage(
  root: Document,
  deps: PageTranslateDeps,
): Promise<PageResult> {
  stopPageTranslation();
  ensureStyle(root);
  applyAppearance(root, deps.appearance ?? DEFAULT_APPEARANCE);

  const blocks = collect(root, deps);

  if (blocks.length === 0) {
    if (!deps.unprompted) {
      const progress = mountProgress(root, stopPageTranslation);
      progress.finish('Nothing to translate on this page');
    }
    // Still worth watching: on an app that renders after load, "nothing to
    // translate" means "nothing yet", and that is the case where pressing the
    // button felt most broken.
    startWatching(root, deps);
    return { translated: 0, failed: 0, unchanged: 0, stopped: false };
  }

  startWatching(root, deps);
  return drainQueue(root, deps, claim(triage(blocks)));
}

/**
 * Drain one batch, reporting as it goes.
 *
 * `initial` is what is worth translating right now; the observers may add to
 * `run.queue` while this drains, and the loop below picks that up rather than
 * finishing and immediately starting again under a second badge.
 */
async function drainQueue(
  root: Document,
  deps: PageTranslateDeps,
  initial: HTMLElement[],
): Promise<PageResult> {
  const appearance = deps.appearance ?? DEFAULT_APPEARANCE;
  const controller = new AbortController();
  const current: Run = {
    controller,
    queue: [...initial],
    inFlight: 0,
    done: 0,
    unprompted: deps.unprompted ?? false,
  };
  run = current;

  const progress = mountProgress(root, stopPageTranslation);
  /** Recomputed, not fixed: the queue can grow under a reader who scrolls. */
  const total = (): number =>
    current.done + current.inFlight + current.queue.length;
  progress.update(0, total());

  let translated = 0;
  let failed = 0;
  /** Blocks the engine handed back exactly as they went in. */
  let unchanged = 0;
  /** Failures since the last block that worked. */
  let consecutiveFailures = 0;
  /** Set when the run abandoned itself rather than being stopped by the user. */
  let gaveUp = false;
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
      const block = current.queue.shift();
      if (!block) return;
      // A block can leave the page between being queued and being reached — an
      // SPA route change, a feed trimming what scrolled past. Not a failure,
      // and translating it would attach text to a node nobody will ever see.
      if (!block.isConnected) continue;

      // Read now rather than at collection time, so a block that changed
      // while the queue drained is translated as it currently reads — and
      // through `visibleText`, so a stylesheet child is never sent to a model.
      const source = visibleText(block).trim();
      current.inFlight++;
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
        if (result.trim() === source) {
          // Nothing came back but what went in. The engines do this on
          // purpose: asked for a language the text is already in, they return
          // it verbatim, which is the honest answer in the selection panel and
          // useless here — inserting it prints the paragraph twice. Measured
          // on the English Wikipedia article with English as the target: all
          // 28 blocks came back byte-identical and the page was doubled.
          //
          // Not restricted to that case on purpose. A block of proper nouns
          // comes back unchanged from a real translation too, and a duplicate
          // of it is just as useless.
          //
          // Left unmarked, so a later run tries it again. Marking it would be
          // cheaper, but the marker means "a translation is appended below
          // this block" and 2.7.7 exists precisely because a marker without
          // one is treated as stale — an SPA had wiped the translation out
          // from under it. Two meanings for one attribute is how that bug
          // comes back.
          unchanged++;
          consecutiveFailures = 0;
        } else if (result.trim()) {
          attach(
            block,
            result.trim(),
            deps.targetLang,
            false,
            appearance.displayMode,
          );
          translated++;
          consecutiveFailures = 0;
        } else {
          // An empty generation is a failure with a friendly face: silently
          // skipping it leaves a gap the reader reads as "already translated".
          attach(
            block,
            '⚠️ no translation returned',
            deps.targetLang,
            true,
            appearance.displayMode,
          );
          failed++;
          consecutiveFailures++;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const reason =
          error instanceof Error ? error.message.trim() : String(error);
        if (!firstError && reason) firstError = reason;
        attach(
          block,
          '⚠️ translation failed',
          deps.targetLang,
          true,
          appearance.displayMode,
        );
        failed++;
        consecutiveFailures++;
      } finally {
        current.inFlight--;
      }

      // Stop rather than march the same failure down the page.
      //
      // With Ollama not running, every block fails the same way and the old
      // behaviour was to mark all of them: twenty-eight ⚠️ lines the reader
      // then has to clear, for one problem that was already obvious by the
      // third. Three in a row is a broken setup, not bad luck — one block
      // failing on its own is, which is why the counter resets on any success.
      if (consecutiveFailures >= GIVE_UP_AFTER) {
        gaveUp = true;
        controller.abort();
        return;
      }
      current.done++;
      handled++;
      progress.update(current.done, total());
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

  // A loop, because the queue is live: the observers can push a block in while
  // these workers drain, and a run that stopped at the queue it started with
  // would hand that block to a second badge a moment later.
  while (!controller.signal.aborted && current.queue.length > 0) {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, current.queue.length) }, () =>
        worker(),
      ),
    );
  }

  const stopped = controller.signal.aborted && !gaveUp;
  if (run === current) run = null;

  if (gaveUp) {
    // Three failures in a row is a broken setup, not a page that needs more
    // watching. Left attached, the observers would go on offering blocks to an
    // engine that is not answering — one badge per screen scrolled.
    stopWatching();
    // Take the debris with it. The three ⚠️ markers proved the point and are
    // now just something to clear before the page reads normally again; the
    // reason is worth keeping, and it goes in the badge.
    for (const marker of queryDeep(
      root,
      `.${BILINGUAL_CLASS}[data-oit-failed]`,
    )) {
      const block = marker.parentElement;
      marker.remove();
      if (block && !block.querySelector(`.${BILINGUAL_CLASS}`)) {
        block.removeAttribute(TRANSLATED_ATTR);
      }
    }
    progress.finish(
      firstError
        ? `Gave up after ${String(GIVE_UP_AFTER)} failures — ${firstError}`
        : `Gave up after ${String(GIVE_UP_AFTER)} failures`,
    );
    return { translated, failed, unchanged, stopped: false };
  }

  const summary = stopped
    ? `Stopped — ${String(translated)} translated`
    : // Every block came back as it went in, so the page is already in the
      // language that was asked for. "Done — 0 translated" is true and tells
      // the reader nothing about why.
      translated === 0 && failed === 0 && unchanged > 0
      ? `Nothing to translate — this page is already in ${deps.targetLang}`
      : failed > 0
        ? `Done — ${String(translated)} translated, ${String(failed)} failed`
        : `Done — ${String(translated)} translated`;
  progress.finish(
    failed > 0 && firstError ? `${summary} — ${firstError}` : summary,
  );

  return { translated, failed, unchanged, stopped };
}

/**
 * The single entry point behind the toolbar button and the keyboard shortcut.
 *
 * One control, four meanings, in the order a user expects: running → stop,
 * translated into some other language → translate again into this one,
 * translated into this one → clear, otherwise → translate. A separate "undo"
 * button would spend permanent screen space on a state that is obvious from
 * the page.
 *
 * The third meaning is the one that took a bug report. Changing the target
 * language in the popup and pressing translate used to *erase* the page,
 * because the toggle asked only "is there a translation here" and the answer
 * was yes. A second press then translated into the new language — so switching
 * language cost two presses, the first of which looked like the feature
 * breaking. What the page is translated *into* is recorded on every inserted
 * node, so the toggle can tell "already done" from "done in the language you
 * just moved away from".
 */
export async function togglePageTranslation(
  root: Document,
  deps: PageTranslateDeps,
): Promise<PageResult | null> {
  if (isPageTranslationRunning()) {
    // A press during a pass the user did not start is not "stop". Automatic
    // translation begins on load, so a press a moment later — out of habit, or
    // because the first blocks had not landed yet — used to abort it and leave
    // the page in English: the button labelled "translate this page" produced
    // no translation at all. Measured, on a real page, at zero blocks.
    //
    // Letting it run is the least surprising answer, and it is not a dead end:
    // the badge is on screen with its own Stop button, which is where stopping
    // something you did not start belongs.
    if (run?.unprompted) return null;
    stopPageTranslation();
    return null;
  }
  if (isPageTranslated(root)) {
    if (isTranslatedInto(root, deps.targetLang)) {
      clearPageTranslation(root);
      root.getElementById(PROGRESS_ID)?.remove();
      return null;
    }
    // Stale: clear the old language out of the way and run again, so one
    // press means one thing.
    clearPageTranslation(root);
    root.getElementById(PROGRESS_ID)?.remove();
  }
  return translatePage(root, deps);
}
