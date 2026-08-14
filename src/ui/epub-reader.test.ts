// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountReader, bookKey, type ReadingPosition } from './epub-reader';
import { collectBlocks } from './blocks';
import { buildEpub } from '../../tests/epub-fixture';

/**
 * The reader page's own markup, read from the file that ships.
 *
 * Not a copy written for the test. `mountReader` throws if an id is missing,
 * so this is the assertion that the page and the module still agree — and a
 * hand-written fixture would keep passing after a rename that breaks the
 * shipped page.
 */
const PAGE = readFileSync(
  resolve(process.cwd(), 'src/entrypoints/epub-reader/index.html'),
  'utf8',
);
const BODY = /<body>([\s\S]*)<\/body>/.exec(PAGE)?.[1] ?? '';

interface Store {
  saved: Map<string, ReadingPosition>;
  urls: string[];
  revoked: string[];
}

function reset(): Store {
  document.body.innerHTML = BODY;
  // jsdom implements neither, and neither is what any of this is about.
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  return { saved: new Map(), urls: [], revoked: [] };
}

function reader(store: Store, onChapter?: (info: { index: number }) => void) {
  return mountReader(document, {
    createUrl: (_bytes, mediaType) => {
      const url = `blob:${mediaType}/${String(store.urls.length)}`;
      store.urls.push(url);
      return url;
    },
    revokeUrl: (url) => store.revoked.push(url),
    loadPosition: (id) => Promise.resolve(store.saved.get(id) ?? null),
    savePosition: (id, position) => {
      store.saved.set(id, position);
      return Promise.resolve();
    },
    onChapter,
  });
}

const id = <T extends HTMLElement>(name: string): T =>
  document.getElementById(name) as T;

let store: Store;
beforeEach(() => {
  store = reset();
});

describe('bookKey', () => {
  it('uses the publisher identifier, which follows the book anywhere', () => {
    expect(
      bookKey({ identifier: 'urn:isbn:9780000', title: 'A', author: 'B' }),
    ).toBe('id:urn:isbn:9780000');
  });

  it('falls back when the identifier is a placeholder', () => {
    // `book-id` is what several packaging tools emit when nobody filled the
    // field in. Filed under that, every such book shares one reading position
    // and each one opens where the last one was left.
    expect(bookKey({ identifier: 'book-id', title: 'A', author: 'B' })).toBe(
      'book:A|B',
    );
    expect(bookKey({ identifier: '', title: 'A', author: 'B' })).toBe(
      'book:A|B',
    );
  });
});

describe('mountReader', () => {
  it('shows the book, its contents and its first chapter', async () => {
    const view = reader(store);
    await view.open(await buildEpub({ title: 'Moby-Dick' }));

    expect(id('oit-epub-title').textContent).toBe('Moby-Dick');
    expect(id('oit-epub-content').textContent).toContain('first chapter');
    expect(id('oit-epub-where').textContent).toContain('1 / 2');
    expect(id('oit-epub-toc').querySelectorAll('button')).toHaveLength(2);
    expect(id('oit-epub-welcome').hidden).toBe(true);
  });

  it('moves through the book and stops at both ends', async () => {
    const view = reader(store);
    await view.open(await buildEpub());

    expect(id<HTMLButtonElement>('oit-epub-previous').disabled).toBe(true);
    await view.next();
    expect(id('oit-epub-content').textContent).toContain('second chapter');
    expect(id<HTMLButtonElement>('oit-epub-next').disabled).toBe(true);
    // Past the end is not an error and not a wrap; it is where you already are.
    await view.next();
    expect(id('oit-epub-where').textContent).toContain('2 / 2');
    await view.previous();
    expect(id('oit-epub-content').textContent).toContain('first chapter');
  });

  it('goes where the contents point', async () => {
    const view = reader(store);
    await view.open(await buildEpub());

    const entries = id('oit-epub-toc').querySelectorAll('button');
    entries[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(id('oit-epub-content').textContent).toContain('second chapter');
    });
    expect(view.position()?.spineIndex).toBe(1);
  });

  it('follows a link the book itself drew into another chapter', async () => {
    // Left as an href this would navigate the extension page, taking the open
    // book with it — so the renderer turns it into a data attribute and this
    // is the half that acts on one.
    const view = reader(store);
    await view.open(
      await buildEpub({
        chapters: [
          {
            name: 'ch1.xhtml',
            body: '<p>The first chapter.</p><p><a href="ch2.xhtml">Read on</a></p>',
          },
          { name: 'ch2.xhtml', body: '<p>The second chapter.</p>' },
        ],
      }),
    );

    const link = id('oit-epub-content').querySelector('a');
    expect(link?.hasAttribute('href')).toBe(false);
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => {
      expect(id('oit-epub-content').textContent).toContain('second chapter');
    });
  });

  it('releases a chapter’s images on the way out of it', async () => {
    // A book read front to back would otherwise hold every illustration it
    // has shown until the tab closed.
    const view = reader(store);
    await view.open(
      await buildEpub({
        chapters: [
          { name: 'ch1.xhtml', body: '<p>One.</p><img src="fig.png" alt=""/>' },
          { name: 'ch2.xhtml', body: '<p>The second chapter.</p>' },
        ],
        extra: [{ name: 'OEBPS/fig.png', body: 'PNGDATA' }],
      }),
    );
    expect(store.urls).toHaveLength(1);
    expect(store.revoked).toHaveLength(0);

    await view.next();
    expect(store.revoked).toEqual(store.urls);
  });

  it('remembers where the reader was and opens there', async () => {
    const bytes = await buildEpub({ identifier: 'urn:uuid:abc' });

    const first = reader(store);
    await first.open(bytes);
    await first.next();
    expect(store.saved.get('id:urn:uuid:abc')?.spineIndex).toBe(1);

    const second = reader(reuse(store));
    await second.open(bytes);
    expect(id('oit-epub-content').textContent).toContain('second chapter');
  });

  it('tells the caller which chapter arrived, so translation can follow', async () => {
    // The hook the entrypoint uses to keep translating as the reader moves. A
    // reader who asked once and has to ask again at every chapter break has
    // been asked, over a book, dozens of times.
    const seen: number[] = [];
    const view = reader(store, (info) => seen.push(info.index));
    await view.open(await buildEpub());
    await view.next();
    expect(seen).toEqual([0, 1]);
  });

  it('says what is wrong with a file it cannot open, and stays on the welcome', async () => {
    const view = reader(store);
    await view.open(new TextEncoder().encode('this is not an EPUB at all'));

    expect(id('oit-epub-error').hidden).toBe(false);
    expect(id('oit-epub-error').textContent).toMatch(/could not be opened/);
    expect(id('oit-epub-welcome').hidden).toBe(false);
    expect(view.book()).toBeNull();
  });

  it('opens a book with no contents, with the contents button turned off', async () => {
    const view = reader(store);
    await view.open(await buildEpub({ nav: 'none' }));
    expect(id<HTMLButtonElement>('oit-epub-toc-toggle').disabled).toBe(true);
    expect(id('oit-epub-content').textContent).toContain('first chapter');
  });
});

describe('what whole-page translation sees on this page', () => {
  it('collects the chapter and none of the reader’s own controls', async () => {
    // The load-bearing claim of the whole design: the chapter goes in <main>
    // and everything else stays outside it, so `ui/blocks.ts` scopes to the
    // book by construction. Get this wrong and a press translates "Contents",
    // "Previous" and "Translate" while the reader waits on paragraph one.
    const view = reader(store);
    await view.open(
      await buildEpub({
        chapters: [
          {
            name: 'ch1.xhtml',
            body: '<h2>The chapter heading</h2><p>A paragraph long enough to be worth translating.</p>',
            label: 'A chapter with a long enough label',
          },
          { name: 'ch2.xhtml', body: '<p>The second chapter of the book.</p>' },
        ],
      }),
    );

    const blocks = collectBlocks(document, { isVisible: () => true });
    expect(blocks.map((block) => block.textContent)).toEqual([
      'The chapter heading',
      'A paragraph long enough to be worth translating.',
    ]);
  });
});

/** A second reader over the same saved positions, as a reopened tab would be. */
function reuse(store: Store): Store {
  document.body.innerHTML = BODY;
  return { saved: store.saved, urls: [], revoked: [] };
}
