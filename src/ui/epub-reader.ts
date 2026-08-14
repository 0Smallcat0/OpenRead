/**
 * The reader: a book on screen, one chapter at a time.
 *
 * Deliberately not a pagination engine. Every other EPUB reader in a browser
 * reflows the text into columns and hands the reader a page-turn, and doing
 * that means owning the layout — fixed heights, absolute positioning, a
 * measured column count. This one puts the chapter in the document and lets it
 * scroll, for one reason: whole-page translation inserts a line under every
 * paragraph, so the height of a chapter changes as it is translated. A
 * paginator would have to re-measure and re-break the whole book underneath the
 * reader's eyes each time a translation landed. A scrolling document simply
 * grows.
 *
 * That choice is what lets the rest of the extension work here unchanged.
 * `ui/blocks.ts` scopes a page to its `<main>`, so the chapter is the content
 * and the toolbar and contents sidebar are excluded by construction; the
 * selection translator, the hover key and `translatePage` all run on this page
 * exactly as they run on a web page.
 *
 * Chrome APIs stay in the entrypoint. Everything here takes a `Document` and
 * its dependencies, so it is testable under jsdom.
 */
import { openEpub, type OpenBook, type TocEntry } from './epub';
import {
  renderChapter,
  CHAPTER_LINK_ATTR,
  CHAPTER_FRAGMENT_ATTR,
} from './epub-render';

/** Ids the page's markup and this module agree on. */
export const READER_IDS = {
  shell: 'oit-epub-shell',
  title: 'oit-epub-title',
  where: 'oit-epub-where',
  toc: 'oit-epub-toc',
  tocToggle: 'oit-epub-toc-toggle',
  content: 'oit-epub-content',
  previous: 'oit-epub-previous',
  next: 'oit-epub-next',
  translate: 'oit-epub-translate',
  welcome: 'oit-epub-welcome',
  choose: 'oit-epub-choose',
  file: 'oit-epub-file',
  error: 'oit-epub-error',
} as const;

export interface ReadingPosition {
  spineIndex: number;
  /** How far down the chapter, 0-1. */
  scrollRatio: number;
}

export interface ReaderDeps {
  createUrl: (bytes: Uint8Array, mediaType: string) => string;
  revokeUrl: (url: string) => void;
  loadPosition: (bookId: string) => Promise<ReadingPosition | null>;
  savePosition: (bookId: string, position: ReadingPosition) => Promise<void>;
  /**
   * Called once a chapter is in the document.
   *
   * This is what makes translation follow the reader through a book: the
   * entrypoint uses it to translate the new chapter when the last one was
   * translated. Without it, a reader who asked for a translation would have to
   * ask again at every chapter break — which, in a book, is the whole book.
   */
  onChapter?: (info: { index: number; total: number; title: string }) => void;
}

export interface Reader {
  open: (bytes: Uint8Array) => Promise<void>;
  goTo: (index: number, fragment?: string) => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  /** Where the reader is, for the entrypoint to save on the way out. */
  position: () => ReadingPosition | null;
  book: () => OpenBook | null;
}

/** How long to sit still before writing the reading position down. */
const SAVE_AFTER_MS = 500;

function required<T extends HTMLElement>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`The reader page has no #${id}.`);
  return element as T;
}

/**
 * A stable name for this book, so the position found on the way back is the
 * one that was left.
 *
 * The publisher's identifier first — an ISBN or a UUID follows a book from one
 * folder to another and survives being re-downloaded. Title and author are the
 * fallback for the many books that ship an identifier of `book-id` or nothing
 * at all, where using it would file every such book under the same key and
 * drop each one at the last position of the previous.
 */
export function bookKey(book: {
  identifier: string;
  title: string;
  author: string;
}): string {
  const identifier = book.identifier.trim();
  const generic = /^(book|book-?id|id|epub|unknown)$/i.test(identifier);
  if (identifier && !generic) return `id:${identifier}`;
  return `book:${book.title.trim()}|${book.author.trim()}`;
}

export function mountReader(doc: Document, deps: ReaderDeps): Reader {
  const shell = required(doc, READER_IDS.shell);
  const title = required(doc, READER_IDS.title);
  const where = required(doc, READER_IDS.where);
  const toc = required(doc, READER_IDS.toc);
  const tocToggle = required<HTMLButtonElement>(doc, READER_IDS.tocToggle);
  const content = required(doc, READER_IDS.content);
  const previous = required<HTMLButtonElement>(doc, READER_IDS.previous);
  const next = required<HTMLButtonElement>(doc, READER_IDS.next);
  const welcome = required(doc, READER_IDS.welcome);
  const error = required(doc, READER_IDS.error);

  let book: OpenBook | null = null;
  let key = '';
  let index = 0;
  let urls: string[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const view = doc.defaultView;

  const scrollRatio = (): number => {
    if (!view) return 0;
    const scrollable = doc.documentElement.scrollHeight - view.innerHeight;
    if (scrollable <= 0) return 0;
    return Math.min(1, Math.max(0, view.scrollY / scrollable));
  };

  const position = (): ReadingPosition | null =>
    book ? { spineIndex: index, scrollRatio: scrollRatio() } : null;

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
  };
  const clearError = (): void => {
    error.textContent = '';
    error.hidden = true;
  };

  const releaseChapterUrls = (): void => {
    for (const url of urls) deps.revokeUrl(url);
    urls = [];
  };

  /** The contents entry a chapter belongs to, for the header and the sidebar. */
  const labelFor = (spineIndex: number): string => {
    if (!book) return '';
    const path = book.spine[spineIndex]?.path;
    const entry = book.toc.find((item) => item.path === path);
    return entry?.label ?? '';
  };

  const buildToc = (): void => {
    toc.replaceChildren();
    if (!book || book.toc.length === 0) {
      tocToggle.disabled = true;
      return;
    }
    tocToggle.disabled = false;
    const list = doc.createElement('ol');
    for (const entry of book.toc) {
      list.appendChild(tocItem(entry));
    }
    toc.appendChild(list);
  };

  const tocItem = (entry: TocEntry): HTMLLIElement => {
    const item = doc.createElement('li');
    item.dataset.depth = String(entry.depth);
    const target = book?.spine.findIndex((s) => s.path === entry.path) ?? -1;
    if (target < 0) {
      // A contents entry pointing at something outside the reading order —
      // a cover page, a landmark. Shown, because a gap in the contents is
      // more confusing than an entry that does not move.
      const span = doc.createElement('span');
      span.textContent = entry.label;
      item.appendChild(span);
      return item;
    }
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = entry.label;
    button.dataset.spineIndex = String(target);
    button.addEventListener('click', () => {
      void goTo(target, entry.fragment);
      closeToc();
    });
    item.appendChild(button);
    return item;
  };

  const closeToc = (): void => {
    toc.hidden = true;
    tocToggle.setAttribute('aria-expanded', 'false');
  };

  const markTocPosition = (): void => {
    for (const button of Array.from(
      toc.querySelectorAll<HTMLButtonElement>('button[data-spine-index]'),
    )) {
      const here = Number(button.dataset.spineIndex) === index;
      button.setAttribute('aria-current', here ? 'true' : 'false');
    }
  };

  /**
   * Follow a link the book itself drew.
   *
   * Delegated rather than bound per anchor: a chapter is replaced wholesale on
   * every move, and one listener on the container outlives all of them.
   */
  content.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.(
      `[${CHAPTER_LINK_ATTR}]`,
    );
    if (!anchor) return;
    const path = anchor.getAttribute(CHAPTER_LINK_ATTR) ?? '';
    const fragment = anchor.getAttribute(CHAPTER_FRAGMENT_ATTR) ?? '';
    const target = book?.spine.findIndex((item) => item.path === path) ?? -1;
    event.preventDefault();
    // A link into a file that is not in the reading order — a footnote page,
    // an image page — has nowhere to go, and silently doing nothing is worse
    // than saying so.
    if (target < 0) {
      showError(
        'That link points somewhere this book does not list as a chapter.',
      );
      return;
    }
    void goTo(target, fragment);
  });

  tocToggle.addEventListener('click', () => {
    const open = toc.hidden;
    toc.hidden = !open;
    tocToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  previous.addEventListener('click', () => void movePrevious());
  next.addEventListener('click', () => void moveNext());

  /**
   * Write the position down after the reader stops moving.
   *
   * On every scroll event would be hundreds of writes a page to
   * `chrome.storage`, which is rate-limited and shared with the settings.
   */
  view?.addEventListener('scroll', () => {
    if (!book) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const here = position();
      if (here) void deps.savePosition(key, here).catch(() => undefined);
    }, SAVE_AFTER_MS);
  });

  async function goTo(target: number, fragment = ''): Promise<void> {
    if (!book) return;
    const bounded = Math.min(Math.max(0, target), book.spine.length - 1);
    const chapter = book.spine[bounded];
    if (!chapter) return;

    clearError();
    releaseChapterUrls();
    index = bounded;

    let rendered;
    try {
      rendered = await renderChapter(
        await book.readText(chapter.path),
        chapter.path,
        {
          has: book.has,
          read: book.read,
          createUrl: deps.createUrl,
        },
        doc,
      );
    } catch (failure) {
      content.replaceChildren();
      showError(
        `This chapter could not be read. ${(failure as Error).message}`,
      );
      return;
    }

    urls = rendered.urls;
    content.replaceChildren(rendered.fragment);

    const label = labelFor(bounded);
    where.textContent = `${String(bounded + 1)} / ${String(book.spine.length)}${
      label ? ` · ${label}` : ''
    }`;
    previous.disabled = bounded === 0;
    next.disabled = bounded === book.spine.length - 1;
    markTocPosition();

    // A link with a fragment means a place inside the chapter; anything else
    // means the top of a new one. Neither is "wherever the last chapter was
    // scrolled to", which is what leaving the scroll position alone would do.
    const anchor = fragment ? doc.getElementById(fragment) : null;
    if (anchor) anchor.scrollIntoView();
    else view?.scrollTo(0, 0);

    void deps
      .savePosition(key, { spineIndex: bounded, scrollRatio: 0 })
      .catch(() => undefined);

    deps.onChapter?.({
      index: bounded,
      total: book.spine.length,
      title: label,
    });
  }

  async function moveNext(): Promise<void> {
    if (book && index < book.spine.length - 1) await goTo(index + 1);
  }
  async function movePrevious(): Promise<void> {
    if (index > 0) await goTo(index - 1);
  }

  async function open(bytes: Uint8Array): Promise<void> {
    clearError();
    let opened: OpenBook;
    try {
      opened = await openEpub(bytes);
    } catch (failure) {
      showError((failure as Error).message);
      welcome.hidden = false;
      shell.hidden = true;
      return;
    }

    releaseChapterUrls();
    book = opened;
    key = bookKey(opened);
    welcome.hidden = true;
    shell.hidden = false;
    title.textContent = opened.title || 'Untitled';
    doc.title = opened.title ? `${opened.title} — OpenRead` : 'OpenRead';
    buildToc();

    const saved = await deps.loadPosition(key).catch(() => null);
    await goTo(saved?.spineIndex ?? 0);
    // Restored after the chapter is in the document, because before that the
    // page has no height to be a fraction of.
    if (saved && saved.scrollRatio > 0 && view) {
      const scrollable = doc.documentElement.scrollHeight - view.innerHeight;
      if (scrollable > 0) view.scrollTo(0, scrollable * saved.scrollRatio);
    }
  }

  return {
    open,
    goTo,
    next: moveNext,
    previous: movePrevious,
    position,
    book: () => book,
  };
}
