/**
 * Choosing what on a page is worth translating.
 *
 * Whole-page translation lives or dies on this decision. Translate too little
 * and the page stays foreign; translate too much and a local model spends
 * minutes on navigation chrome, code samples, and the same string in three
 * nested wrappers. Every rule below exists because of a specific way the naive
 * version — "send every element with text" — goes wrong.
 *
 * DOM-dependent by nature, so it lives in `ui/` rather than the framework-free
 * `core/`. It touches no Chrome API and no network, so jsdom is enough to
 * drive all of it.
 */
import {
  MAX_TOKENS,
  takenIndices,
  tokenFor,
  type ProtectedText,
} from '../core/glossary';

/**
 * Leaf-level containers of prose. Deliberately not `div` or `span`: those
 * appear at every depth, and including them means translating a paragraph and
 * each of its three ancestors as well.
 */
export const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption, td, th, summary';

/**
 * Never translate inside these. `code`/`pre`/`kbd`/`samp` because a model
 * asked to translate a code sample will cheerfully translate the identifiers;
 * the form controls because their text is user data; `[translate="no"]` and
 * `.notranslate` because the page has explicitly asked, and honouring that is
 * the difference between a tool and a nuisance.
 */
const SKIP_WITHIN =
  'script, style, noscript, code, pre, kbd, samp, svg, math, textarea, select, option, [contenteditable="true"], [translate="no"], .notranslate';

/**
 * Navigational chrome. Not "probably not worth translating" — actively wrong
 * to translate: a real browser run on the Wikipedia article for Ollama picked
 * up **325** blocks, of which 277 were the sidebar, the table of contents, and
 * the account links across the top. Because the DOM puts all of that before
 * the article, a queue in document order translated "Create account" and
 * "View history" while the reader waited on paragraph one.
 */
const NAVIGATION =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"], .toc, #toc, .navbox, .sidebar';

/**
 * Citations and reference lists.
 *
 * A bibliography is a lookup key, not prose. Translated, it stops working:
 * one real article turned the publisher `Ollama` into `奧拉瑪` and the article
 * title `"Blog"` into `"博客"`, so a reader could no longer find either. Half
 * of that page's remaining blocks were references — 16 of 48 — so skipping
 * them is also most of a third off the work.
 *
 * `cite` is standard HTML; the rest are the classes MediaWiki emits, which is
 * where a reader is most likely to meet a reference list at all.
 */
const CITATIONS =
  'cite, .citation, .reference, .reflist, .references, ol.references, .mw-references-wrap, .mw-cite-backlink';

/**
 * Where a page keeps the thing it is about. Scoping to this is what makes
 * "document order" mean "reading order": these landmarks exclude the chrome by
 * construction rather than by blocklist, and a page without one falls back to
 * the body, where the blocklist above still applies.
 */
const CONTENT_ROOT = 'main, [role="main"], article';

/**
 * Our own injected UI, which must never become input to itself.
 *
 * Exported because `fullpage.ts` needs the same list to tell its
 * MutationObserver which changes it caused. It kept a second copy for a while,
 * and the copy was missing the selection panel and the floating icon — so
 * opening a translation panel, or every token of a streamed one, read as the
 * page growing new text and scheduled a full re-collection of it.
 */
export const OWN_UI =
  '#oit-translate-panel, #oit-translate-icon, .oit-bilingual, #oit-page-progress, .oit-pdf-translation';

/** Marks a block whose translation has already been appended. */
export const TRANSLATED_ATTR = 'data-oit-translated';

/**
 * Class on the inserted translation node.
 *
 * Lives here rather than in `fullpage.ts` because the collector needs it: the
 * marker above is a claim, and this node is the evidence for it. Re-exported
 * from `fullpage.ts`, which is where callers have always imported it from.
 */
export const BILINGUAL_CLASS = 'oit-bilingual';

/**
 * Shorter than this is almost always chrome — "Home", "12", "Read more" — and
 * each one still costs a full model round trip.
 */
export const MIN_BLOCK_CHARS = 12;

/**
 * Addresses, not prose. A URL, a bare domain or an email has letters in it and
 * nothing to translate, so a model handed one returns an empty generation and
 * the page shows a failure the reader can do nothing about.
 *
 * Found on the Wikipedia article for Ollama: the infobox cell reading
 * `github.com/ollama/ollama` was the one block that failed on every run.
 */
const ADDRESS_LIKE = [
  /https?:\/\/\S+/gi,
  /\b[\w.-]+@[\w.-]+\.\w+\b/g,
  // A bare domain, optionally with a path. The `[a-z]{2,}` tail keeps this off
  // ordinary prose: "version 2.5.0" and "e.g." have no two-letter word after
  // the dot, so neither is mistaken for a host.
  /\b(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?/gi,
];

/**
 * The text of an element as a reader sees it, ignoring descendants that are
 * not prose.
 *
 * `textContent` is the obvious call and it is wrong: it concatenates the
 * contents of `<style>` and `<script>` children too. Measured on one Wikipedia
 * reference item, `textContent` was **2,158 characters of which 2,100 were a
 * stylesheet** — and that CSS went to the translator, which dutifully rendered
 * `no-repeat` as `無重複` and `center` as `中心` inside a rule set.
 *
 * `closest()` cannot catch this, because it looks at ancestors and the problem
 * is a child. `innerText` would, but it forces layout and jsdom does not
 * implement it, which would put this rule beyond the reach of every test.
 *
 * Skipping our own insertions here too means a re-run reads the original text
 * rather than the original plus last run's translation.
 */
/**
 * Inline elements whose text is code rather than prose.
 *
 * A translator asked to translate `allow="fullscreen"` does not decline — it
 * removes it. Measured on MDN: `This attribute is considered a legacy attribute
 * and redefined as allow="fullscreen *".` came back as
 * `此屬性被視為遺留屬性並重新定義為 。`, with the thing the sentence is *about*
 * simply gone. On a documentation page that is most of the value of the
 * sentence, and the reader has no way to tell anything was dropped.
 */
export const VERBATIM = 'code, kbd, samp, var, tt';

/**
 * A block's text with its code spans hidden behind placeholders.
 *
 * The same mechanism the glossary uses, and the same placeholder, measured
 * against nine target languages — see `core/glossary.ts` for why it looks like
 * that. Returns no values when the block has no code in it, which is the
 * common case and must cost nothing.
 */
export function protectedText(element: Element): ProtectedText {
  const plain = visibleText(element);
  const taken = takenIndices(plain);
  const values: string[] = [];
  const indices: number[] = [];
  let next = 0;

  const walk = (node: Element): string => {
    let out = '';
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      // Before the skip list, not after: `code`, `kbd` and `samp` are *in*
      // that list, which is how the code came to be missing from the
      // translation in the first place. Dropping it from what is sent and
      // dropping it from what is shown are two different decisions, and only
      // the first one was ever made.
      if (el.matches(VERBATIM) && values.length < MAX_TOKENS) {
        const literal = visibleText(el);
        // Nothing worth protecting, and a placeholder standing in for nothing
        // is one more thing that can fail to come back.
        if (!literal.trim()) continue;
        while (taken.has(next)) next++;
        taken.add(next);
        values.push(literal);
        indices.push(next);
        out += tokenFor(next);
        continue;
      }
      if (
        el.matches(SKIP_WITHIN) ||
        el.matches(OWN_UI) ||
        el.matches(CITATIONS)
      ) {
        continue;
      }
      out += walk(el);
    }
    return out;
  };

  const text = walk(element);
  // A block that is only code has nothing left to translate, and a lone
  // placeholder has no language for the engine to detect.
  if (
    values.length === 0 ||
    !/\p{L}/u.test(text.replace(/\[\[\s*\d+\s*\]\]/g, ' '))
  ) {
    return { text: plain, values: [], indices: [] };
  }
  return { text, values, indices };
}

export function visibleText(element: Element): string {
  let out = '';
  for (const node of Array.from(element.childNodes)) {
    // 3 = TEXT_NODE, 1 = ELEMENT_NODE. Numeric because `Node` is a DOM global
    // and this file is read in environments that do not define it.
    if (node.nodeType === 3) {
      out += node.nodeValue ?? '';
    } else if (node.nodeType === 1) {
      const child = node as Element;
      if (
        child.matches(SKIP_WITHIN) ||
        child.matches(OWN_UI) ||
        // Citations are excluded here as well as by `closest` above, because
        // the same ancestor-only blind spot applies: a paragraph that ends in
        // an inline <cite> should have its prose translated and the citation
        // left alone, and a paragraph that is *only* a citation then has no
        // visible text at all and drops out by itself.
        child.matches(CITATIONS)
      ) {
        continue;
      }
      out += visibleText(child);
    }
  }
  return out;
}

/** Does this text contain anything a translator could act on? */
export function hasTranslatableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_BLOCK_CHARS) return false;
  // A block of digits, punctuation, or emoji has nothing to translate but
  // would still cost a round trip and come back mangled.
  if (!/\p{L}/u.test(trimmed)) return false;

  // Measure what is left once the addresses are removed. A sentence that
  // merely mentions a URL keeps its prose and stays; a cell that is only a URL
  // has nothing left and goes.
  let prose = trimmed;
  for (const pattern of ADDRESS_LIKE) prose = prose.replace(pattern, ' ');
  prose = prose.trim();

  return prose.length >= MIN_BLOCK_CHARS && /\p{L}/u.test(prose);
}

export interface CollectOptions {
  /**
   * Whether an element is actually on screen. Injected because the honest
   * implementation needs layout, which jsdom does not do — leaving it
   * implicit would mean this file could only be tested in a real browser.
   */
  isVisible: (element: HTMLElement) => boolean;
  /** Skip blocks already in the target language (the same check selection uses). */
  shouldSkipText?: (text: string) => boolean;
}

/**
 * Collect the blocks on `root` worth sending to the model, in document order.
 *
 * Document order matters: a page fills from the top, which is where the reader
 * is looking, so the first translations to arrive are the ones being waited on.
 */
export function collectBlocks(
  root: ParentNode,
  { isVisible, shouldSkipText }: CollectOptions,
): HTMLElement[] {
  const scope = contentRoot(root);
  const candidates = Array.from(
    scope.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  );

  const kept = candidates.filter((element) => {
    if (element.hasAttribute(TRANSLATED_ATTR)) {
      // The marker claims a translation is appended below this block. React
      // and Vue reconcile a route change by reusing the element and writing
      // new text into it, which destroys the appended node and leaves the
      // marker behind — so the claim outlives the thing it is about, and the
      // new route reads as already translated. Measured on a two-paragraph
      // SPA: after `p.textContent = …`, both blocks still carried the marker,
      // neither carried a translation, and asking for one answered "Nothing
      // to translate on this page".
      //
      // The appended node is the evidence. Without it the marker is stale, so
      // drop it and let the block back into the queue.
      // A direct-child scan rather than `:scope > …`: the rule is "does this
      // block carry its own translation", a parent must not be excused by a
      // child's, and `:scope` inside a shadow root is not something to depend
      // on — jsdom answers it wrong, and a selector that quietly means
      // something else in one tree is a bad foundation for a skip rule.
      const own = Array.from(element.children).some((child) =>
        child.classList.contains(BILINGUAL_CLASS),
      );
      if (own) return false;
      element.removeAttribute(TRANSLATED_ATTR);
    }
    if (element.closest(SKIP_WITHIN)) return false;
    if (element.closest(NAVIGATION)) return false;
    if (element.closest(CITATIONS)) return false;
    if (element.closest(OWN_UI)) return false;

    // Leaf-most wins. A `li` wrapping a `p` would otherwise be translated
    // once as itself and once as its child — twice the cost, and the page
    // shows the same translation twice.
    if (element.querySelector(BLOCK_SELECTOR)) return false;

    if (!hasTranslatableText(visibleText(element))) return false;
    if (!isVisible(element)) return false;
    return true;
  });

  const here = shouldSkipText
    ? kept.filter((element) => !shouldSkipText(visibleText(element)))
    : kept;

  // A web component keeps its text in a shadow root, and `querySelectorAll`
  // does not go in. Measured on a page with two paragraphs inside an open
  // shadow root: `Done — 1 translated` — the one paragraph in the light DOM,
  // with the component's own content silently untouched.
  //
  // Each root is collected on its own terms: `contentRoot`, the navigation and
  // citation skips, leaf-most-wins. `closest()` does not cross a shadow
  // boundary either, so a component's internals are their own document as far
  // as those rules go — which is also the right answer, since a component's
  // `<nav>` is its own navigation and not the page's.
  //
  // Open roots only. A closed one is closed to us as much as to the page.
  for (const shadow of openShadowRoots(scope)) {
    here.push(...collectBlocks(shadow, { isVisible, shouldSkipText }));
  }
  return here;
}

/**
 * Open shadow roots under `root`, hosts in document order, nested ones
 * included via the recursion in `collectBlocks`.
 */
export function openShadowRoots(root: ParentNode): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (element.shadowRoot) found.push(element.shadowRoot);
  }
  return found;
}

/**
 * `querySelectorAll` over a root and every open shadow root beneath it.
 *
 * Needed wherever the extension asks a question about its own inserted nodes —
 * is this page translated, clear it, what language is it in — because the
 * answer stopped being complete the moment blocks could come from a component.
 */
export function queryDeep<T extends Element>(
  root: ParentNode,
  selector: string,
): T[] {
  const found = Array.from(root.querySelectorAll<T>(selector));
  for (const shadow of openShadowRoots(root)) {
    found.push(...queryDeep<T>(shadow, selector));
  }
  return found;
}

/**
 * Narrow to the page's main content when it declares one.
 *
 * Measured on real pages: Wikipedia's article for Ollama goes from 325 blocks
 * to 48, MDN's AbortController page from 135 to 24, and the first block to be
 * translated changes from "Current events" to the opening sentence. A page
 * with no such landmark — example.com, most hand-written HTML — is unaffected.
 */
export function contentRoot(root: ParentNode): ParentNode {
  return root.querySelector<HTMLElement>(CONTENT_ROOT) ?? root;
}

/**
 * The default visibility test: cheap, and it does not need `getComputedStyle`
 * on every candidate. `offsetParent` is null for `display: none` and anything
 * inside it; the rect check catches collapsed and zero-size elements that are
 * technically laid out. `position: fixed` elements report a null offsetParent
 * while being perfectly visible, so they fall through to the rect.
 */
export function isElementVisible(element: HTMLElement): boolean {
  if (element.offsetParent !== null) return true;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
