/**
 * Turning one chapter of an EPUB into DOM that is safe to put on the page.
 *
 * A chapter is XHTML written by someone else, and the page it lands on is an
 * extension page — the one context in the browser where `chrome.*` is
 * reachable and every host is permitted. So this is not a formatting pass with
 * a security note attached; it is a boundary, and the interesting part is
 * everything it refuses to carry across.
 *
 * Two rules, and both are absolute:
 *
 * 1. **No script.** The page's content security policy already forbids inline
 *    and remote script, so a `<script>` that survived this would not run — but
 *    depending on one control for a whole class of attack is how the one
 *    exception nobody thought of gets through. Script elements, `on…`
 *    handlers and `javascript:` URLs are removed here as well.
 * 2. **No network request, ever.** OpenRead's claim is that a book stays on
 *    the machine, and `pnpm e2e:egress` exists because that claim is worth
 *    nothing unasserted. An image, a stylesheet or a font pointing at a remote
 *    host is a request the reader did not make and a beacon telling a
 *    publisher which page they are on, so remote references are dropped rather
 *    than fetched. Everything an image needs is inside the archive; the
 *    specification requires it.
 *
 * A link the reader clicks is a different thing from a request the page makes,
 * so ordinary web links survive — forced into a new tab, because a chapter
 * that navigates the reader away takes the open book with it.
 */
import { isRemoteHref, resolvePath, fragmentOf } from './epub';

/** Elements with no place in a rendered chapter. */
const DROP_ELEMENTS =
  'script, noscript, iframe, frame, object, embed, applet, form, input, button, select, textarea, base, link, meta, style, audio, video, track, source';

/**
 * The book's own stylesheets are not applied, and `<style>` above is why.
 *
 * A publisher's CSS assumes a paginated viewport it controls: fixed heights,
 * absolute positioning, page-break rules, and font sizes in units that mean
 * something on an e-reader. Dropped into a scrolling page it produces
 * overlapping text as often as it produces the intended look — and it would be
 * styling the translated lines this extension inserts as well, which it has
 * never seen. The reader's own typography is applied instead.
 */

/** URL schemes a link may keep. Everything else loses its href. */
const SAFE_LINK_SCHEME = /^(https?|mailto):/i;

/** Media types by file extension, for building an object URL. */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/** The XLink namespace, which is how SVG referenced images before SVG 2. */
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Attribute carrying a link into another chapter, for the reader to act on. */
export const CHAPTER_LINK_ATTR = 'data-oit-epub-href';
/** The `#…` that link pointed at, if any. */
export const CHAPTER_FRAGMENT_ATTR = 'data-oit-epub-fragment';

export interface ChapterAssets {
  has: (path: string) => boolean;
  read: (path: string) => Promise<Uint8Array>;
  /**
   * A URL the page can render the bytes from. Injected rather than called
   * directly, because `URL.createObjectURL` does not exist in jsdom and
   * calling it here would put every test of this file in a real browser.
   */
  createUrl: (bytes: Uint8Array, mediaType: string) => string;
}

export interface RenderedChapter {
  fragment: DocumentFragment;
  /** Object URLs this chapter created, to release when leaving it. */
  urls: string[];
}

export function mediaTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return MEDIA_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Parse a chapter, tolerating the ones that are not well-formed.
 *
 * EPUB requires XHTML, and a great many books ship files that are not: an
 * unescaped `&`, an unclosed `<br>`, a stray attribute. Parsed strictly those
 * produce a `<parsererror>` document and a blank chapter; parsed as HTML they
 * produce the book. Strict first, because when a file *is* well-formed the XML
 * parser keeps namespaces intact, which SVG cover pages need.
 */
export function parseChapter(xhtml: string): Document {
  const strict = new DOMParser().parseFromString(
    xhtml,
    'application/xhtml+xml',
  );
  if (strict.getElementsByTagName('parsererror').length === 0) return strict;
  return new DOMParser().parseFromString(xhtml, 'text/html');
}

/** Remove every `on…` handler, wherever it appears. */
function stripEventHandlers(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
  }
}

/**
 * Take the `url(…)` out of an inline style.
 *
 * An inline style is worth keeping — centred verse, a hanging indent — but
 * `background-image: url(https://…)` is a network request wearing a costume,
 * and one that no element-level rule would catch.
 */
function stripStyleUrls(element: Element): void {
  const style = element.getAttribute('style');
  if (!style) return;
  if (!/url\s*\(/i.test(style)) return;
  const cleaned = style
    .split(';')
    .filter((declaration) => !/url\s*\(/i.test(declaration))
    .join(';')
    .trim();
  if (cleaned) element.setAttribute('style', cleaned);
  else element.removeAttribute('style');
}

/**
 * Rewrite one link.
 *
 * Three kinds, and each gets a different answer: a jump inside this chapter
 * stays a plain anchor, a jump into another chapter becomes a data attribute
 * for the reader to handle (so nothing navigates the extension page away from
 * the open book), and an ordinary web link opens in a new tab. Anything else
 * — `javascript:`, `data:`, a scheme nobody has heard of — keeps its text and
 * loses its href.
 */
function rewriteLink(anchor: Element, chapterPath: string): void {
  const href = anchor.getAttribute('href');
  if (href === null) return;

  if (href.startsWith('#')) return;

  if (isRemoteHref(href)) {
    if (!SAFE_LINK_SCHEME.test(href)) {
      anchor.removeAttribute('href');
      return;
    }
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
    return;
  }

  anchor.setAttribute(CHAPTER_LINK_ATTR, resolvePath(chapterPath, href));
  anchor.setAttribute(CHAPTER_FRAGMENT_ATTR, fragmentOf(href));
  anchor.removeAttribute('href');
}

/**
 * One chapter, ready to insert.
 *
 * Images are resolved from inside the archive and handed to the page as object
 * URLs, which the caller releases on leaving the chapter — a book with a
 * hundred illustrations read front to back would otherwise hold every one of
 * them in memory until the tab closed.
 */
export async function renderChapter(
  xhtml: string,
  chapterPath: string,
  assets: ChapterAssets,
  into: Document = document,
): Promise<RenderedChapter> {
  const doc = parseChapter(xhtml);
  const body = doc.getElementsByTagName('body')[0] ?? doc.documentElement;

  for (const element of Array.from(body.querySelectorAll(DROP_ELEMENTS))) {
    element.remove();
  }
  unwrapChapterFurniture(body);

  const urls: string[] = [];
  const source = async (path: string): Promise<string | null> => {
    if (!assets.has(path)) return null;
    try {
      const url = assets.createUrl(await assets.read(path), mediaTypeFor(path));
      urls.push(url);
      return url;
    } catch {
      // A resource that will not decompress costs a picture, not the chapter.
      return null;
    }
  };

  for (const element of Array.from(body.querySelectorAll('*'))) {
    stripEventHandlers(element);
    stripStyleUrls(element);

    // A responsive image set is several more URLs, all of them unresolved.
    element.removeAttribute('srcset');
    element.removeAttribute('poster');

    if (element.localName === 'a') rewriteLink(element, chapterPath);

    // `src` on an image, `href`/`xlink:href` on an SVG <image>. All three name
    // a picture and all three are fetched without anyone clicking anything.
    const pointers: [string | null, string][] = [
      [element.getAttribute('src'), 'src'],
      element.localName === 'image'
        ? [element.getAttribute('href'), 'href']
        : [null, ''],
      [element.getAttributeNS(XLINK_NS, 'href'), 'xlink'],
    ];

    for (const [value, attribute] of pointers) {
      if (value === null) continue;
      if (isRemoteHref(value)) {
        // Not fetched, and not left pointing at a host either: an <img> whose
        // src is removed still renders, as a broken picture, so the element
        // goes with it.
        element.remove();
        break;
      }
      const url = await source(resolvePath(chapterPath, value));
      if (url === null) {
        element.remove();
        break;
      }
      if (attribute === 'xlink') element.setAttributeNS(XLINK_NS, 'href', url);
      else element.setAttribute(attribute, url);
    }
  }

  const fragment = into.createDocumentFragment();
  for (const child of Array.from(body.childNodes)) {
    fragment.appendChild(into.importNode(child, true));
  }
  return { fragment, urls };
}

/**
 * Keep the contents of a chapter's `<header>` and `<footer>`, drop the wrapper.
 *
 * On a web page those elements mean site chrome, and `ui/blocks.ts` skips
 * everything inside them for good reason — a masthead is not what the reader
 * came for. In a book they mean something else entirely: a chapter's `<header>`
 * is where its title lives. Left in place, the one line of a chapter that
 * names it is the one line that never gets translated. Unwrapping keeps the
 * heading and takes the misleading label away.
 */
function unwrapChapterFurniture(body: Element): void {
  for (const wrapper of Array.from(body.querySelectorAll('header, footer'))) {
    const parent = wrapper.parentNode;
    if (!parent) continue;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }
}
