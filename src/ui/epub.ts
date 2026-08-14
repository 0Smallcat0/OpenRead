/**
 * What an EPUB says about itself: its chapters, in order, and its contents.
 *
 * An EPUB is a zip (`core/zip.ts`) holding an XML description of a book. Three
 * documents matter: `META-INF/container.xml` names the package file, the
 * package file lists every resource and the order to read them in, and a
 * navigation document gives the table of contents. This module turns those
 * into a `Book` and does nothing else — no rendering, no translation.
 *
 * DOM-dependent by nature, like `ui/blocks.ts`: reading XML without a parser
 * means writing one, and `DOMParser` is right there in every environment this
 * runs in, jsdom included. It touches no Chrome API and no network.
 *
 * Two versions of the format are in the wild and both are common. EPUB 3 puts
 * the contents in an XHTML `<nav>`; EPUB 2 puts them in a separate NCX file.
 * Books that declare EPUB 3 frequently ship an NCX as well, for readers that
 * predate the change — so this reads whichever one is there, preferring the
 * newer.
 */
import {
  readCentralDirectory,
  readZipEntry,
  decodeText,
  entryMap,
  type ZipEntry,
} from '../core/zip';

/** Where every EPUB says to start looking. Fixed by the specification. */
const CONTAINER_PATH = 'META-INF/container.xml';

/** The media type of an EPUB 2 navigation document. */
const NCX_MEDIA_TYPE = 'application/x-dtbncx+xml';

export interface ManifestItem {
  id: string;
  /** Path inside the archive, already resolved against the package file. */
  path: string;
  mediaType: string;
  properties: string[];
}

export interface SpineItem {
  id: string;
  path: string;
  mediaType: string;
}

export interface TocEntry {
  label: string;
  /** Path inside the archive, without its fragment. */
  path: string;
  /** The `#…` the entry pointed at, or ''. */
  fragment: string;
  /** Nesting level, 0 for a top-level entry. */
  depth: number;
}

export interface BookMeta {
  title: string;
  author: string;
  /**
   * The publisher's identifier for this book — an ISBN, a UUID, a URL.
   * Reading position is remembered under this, so the same book opened from a
   * different folder is still the same book.
   */
  identifier: string;
  language: string;
}

export interface Book extends BookMeta {
  /** Reading order. */
  spine: SpineItem[];
  toc: TocEntry[];
  manifest: Map<string, ManifestItem>;
}

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

/**
 * An opened book: what it says about itself, plus a way to read its files.
 *
 * The archive stays in memory as bytes and entries are inflated on demand.
 * Inflating every chapter up front would be simpler and is the wrong trade: a
 * reader opens one chapter at a time, and a large illustrated book is tens of
 * megabytes of images nobody has asked to look at yet.
 */
export interface OpenBook extends Book {
  read: (path: string) => Promise<Uint8Array>;
  readText: (path: string) => Promise<string>;
  has: (path: string) => boolean;
}

function parseXml(xml: string, what: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // `parseFromString` does not throw. It returns a document whose root is a
  // `<parsererror>`, which reads as a perfectly ordinary document to anything
  // that does not look for it.
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new EpubError(`This EPUB's ${what} is not valid XML.`);
  }
  return doc;
}

/**
 * Elements by local name, whatever namespace prefix the file happened to use.
 *
 * The package format has a default namespace, so most files write `<item>`;
 * others declare a prefix and write `<opf:item>`. `getElementsByTagName`
 * matches the qualified name and therefore finds one of the two, which is how
 * a reader ends up with an empty manifest for a book that is perfectly valid.
 */
function byName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

/** Whether an href points somewhere other than inside this archive. */
export function isRemoteHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href.trim()) && !href.startsWith('#');
}

/**
 * A path inside the archive, from an href written relative to another file.
 *
 * Zip entry names are raw UTF-8 while hrefs are percent-encoded, so a chapter
 * called `第一章.xhtml` is `%E7%AC%AC…` in the package file and the literal
 * characters in the archive — a lookup on the undecoded string finds nothing,
 * and the book opens with the chapter missing rather than with an error.
 */
export function resolvePath(base: string, href: string): string {
  const withoutFragment = href.split('#')[0] ?? '';
  let relative = withoutFragment;
  try {
    relative = decodeURIComponent(withoutFragment);
  } catch {
    // A stray `%` that is not an escape. Better the raw string than nothing.
  }
  if (!relative) return '';

  const parts = relative.startsWith('/')
    ? []
    : base.split('/').slice(0, -1).filter(Boolean);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** The `#…` part of an href, without the `#`. */
export function fragmentOf(href: string): string {
  const at = href.indexOf('#');
  return at < 0 ? '' : href.slice(at + 1);
}

/** The package file's path, as `META-INF/container.xml` gives it. */
export function findPackagePath(containerXml: string): string {
  const doc = parseXml(containerXml, 'container.xml');
  for (const root of byName(doc, 'rootfile')) {
    const path = root.getAttribute('full-path');
    if (path) return resolvePath('', path);
  }
  throw new EpubError('This EPUB does not say where its package file is.');
}

/**
 * The package file: what the book is, what it is made of, and its order.
 *
 * `packagePath` is needed because every href in here is relative to it, and
 * the package file is not required to sit at the root of the archive — the
 * common layout puts it in `OEBPS/`, so a manifest read without it points at
 * files that are one directory up from where they are.
 */
export function parsePackage(
  packageXml: string,
  packagePath: string,
): {
  meta: BookMeta;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  navPath: string;
  ncxPath: string;
} {
  const doc = parseXml(packageXml, 'package file');

  const metadata = byName(doc, 'metadata')[0];
  const metaText = (name: string): string => {
    if (!metadata) return '';
    const element = byName(metadata, name)[0];
    return element?.textContent?.trim() ?? '';
  };

  const manifest = new Map<string, ManifestItem>();
  for (const item of byName(doc, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href || isRemoteHref(href)) continue;
    manifest.set(id, {
      id,
      path: resolvePath(packagePath, href),
      mediaType: item.getAttribute('media-type') ?? '',
      properties: (item.getAttribute('properties') ?? '')
        .split(/\s+/)
        .filter(Boolean),
    });
  }

  const spine: SpineItem[] = [];
  for (const ref of byName(doc, 'itemref')) {
    const idref = ref.getAttribute('idref');
    const item = idref ? manifest.get(idref) : undefined;
    // A spine entry that names nothing in the manifest is a broken book, and
    // the useful response is to read the chapters that do exist.
    if (!item) continue;
    spine.push({ id: item.id, path: item.path, mediaType: item.mediaType });
  }
  if (spine.length === 0) {
    throw new EpubError('This EPUB lists no chapters to read.');
  }

  // EPUB 3 marks its navigation document in the manifest; EPUB 2 points at an
  // NCX from the spine element's `toc` attribute.
  let navPath = '';
  let ncxPath = '';
  for (const item of manifest.values()) {
    if (item.properties.includes('nav')) navPath = item.path;
    if (item.mediaType === NCX_MEDIA_TYPE && !ncxPath) ncxPath = item.path;
  }
  const spineElement = byName(doc, 'spine')[0];
  const tocId = spineElement?.getAttribute('toc');
  if (tocId) {
    const item = manifest.get(tocId);
    if (item) ncxPath = item.path;
  }

  return {
    meta: {
      title: metaText('title'),
      author: metaText('creator'),
      identifier: metaText('identifier'),
      language: metaText('language'),
    },
    manifest,
    spine,
    navPath,
    ncxPath,
  };
}

/** EPUB 3's table of contents: an XHTML `<nav>` holding nested lists. */
export function parseNav(navXhtml: string, navPath: string): TocEntry[] {
  const doc = parseXml(navXhtml, 'navigation document');
  const navs = byName(doc, 'nav');
  // A navigation document may hold several: the contents, a page list, a list
  // of illustrations. Only the first is the table of contents, and it says so.
  const toc =
    navs.find(
      (nav) =>
        nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type') === 'toc' ||
        nav.getAttribute('epub:type') === 'toc' ||
        nav.getAttribute('role') === 'doc-toc',
    ) ?? navs[0];
  if (!toc) return [];

  const entries: TocEntry[] = [];
  const walk = (list: Element, depth: number): void => {
    for (const item of Array.from(list.children)) {
      if (item.localName !== 'li') continue;
      const anchor = Array.from(item.children).find(
        (child) => child.localName === 'a' || child.localName === 'span',
      );
      const href = anchor?.getAttribute('href') ?? '';
      if (anchor && !isRemoteHref(href)) {
        entries.push({
          label: anchor.textContent?.trim() ?? '',
          path: href ? resolvePath(navPath, href) : '',
          fragment: fragmentOf(href),
          depth,
        });
      }
      for (const child of Array.from(item.children)) {
        if (child.localName === 'ol' || child.localName === 'ul') {
          walk(child, depth + 1);
        }
      }
    }
  };
  for (const list of Array.from(toc.children)) {
    if (list.localName === 'ol' || list.localName === 'ul') walk(list, 0);
  }
  return entries.filter((entry) => entry.label);
}

/** EPUB 2's table of contents: a separate NCX document. */
export function parseNcx(ncxXml: string, ncxPath: string): TocEntry[] {
  const doc = parseXml(ncxXml, 'navigation document');
  const map = byName(doc, 'navMap')[0];
  if (!map) return [];

  const entries: TocEntry[] = [];
  const walk = (parent: Element, depth: number): void => {
    for (const point of Array.from(parent.children)) {
      if (point.localName !== 'navPoint') continue;
      const label = byName(point, 'text')[0]?.textContent?.trim() ?? '';
      const href =
        Array.from(point.children)
          .find((child) => child.localName === 'content')
          ?.getAttribute('src') ?? '';
      if (label && !isRemoteHref(href)) {
        entries.push({
          label,
          path: href ? resolvePath(ncxPath, href) : '',
          fragment: fragmentOf(href),
          depth,
        });
      }
      walk(point, depth + 1);
    }
  };
  walk(map, 0);
  return entries;
}

/**
 * Read a book from the bytes of an `.epub` file.
 *
 * Everything that can fail says what failed in a sentence a reader can act on
 * — "this is not an EPUB" and "this EPUB lists no chapters" are different
 * problems, and a viewer that answers both with a blank page is telling the
 * reader to guess.
 */
export async function openEpub(bytes: Uint8Array): Promise<OpenBook> {
  let entries: ZipEntry[];
  try {
    entries = readCentralDirectory(bytes);
  } catch (error) {
    throw new EpubError(
      `This file could not be opened as an EPUB. ${(error as Error).message}`,
    );
  }
  const files = entryMap(entries);

  const read = async (path: string): Promise<Uint8Array> => {
    const entry = files.get(path);
    if (!entry) throw new EpubError(`This EPUB has no file called "${path}".`);
    return readZipEntry(bytes, entry);
  };
  const readText = async (path: string): Promise<string> =>
    decodeText(await read(path));

  if (!files.has(CONTAINER_PATH)) {
    throw new EpubError(
      'This is a zip file, but not an EPUB: it has no META-INF/container.xml.',
    );
  }

  const packagePath = findPackagePath(await readText(CONTAINER_PATH));
  const { meta, manifest, spine, navPath, ncxPath } = parsePackage(
    await readText(packagePath),
    packagePath,
  );

  // Contents are a convenience, not the book. A malformed navigation document
  // must cost the sidebar and not the reading.
  let toc: TocEntry[] = [];
  try {
    if (navPath && files.has(navPath)) {
      toc = parseNav(await readText(navPath), navPath);
    }
    if (toc.length === 0 && ncxPath && files.has(ncxPath)) {
      toc = parseNcx(await readText(ncxPath), ncxPath);
    }
  } catch {
    toc = [];
  }

  return {
    ...meta,
    spine,
    toc,
    manifest,
    read,
    readText,
    has: (path: string) => files.has(path),
  };
}
