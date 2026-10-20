// @vitest-environment jsdom
/**
 * The half of the PDF path that is not geometry.
 *
 * Paragraph reconstruction is measured in `pdf-blocks.test.ts` and against a
 * real paper in `e2e:page`; what is here is the queue — which page is handed
 * to which worker, and when. That is where a defect hid for four releases:
 * it needs a slow translation to show, every warm run is fast, and the only
 * run slow enough to expose it was a cold profile downloading a language pack.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  translatePdf,
  stopPdfTranslation,
  clearPdfTranslation,
  PDF_TRANSLATION_CLASS,
} from './pdf-translate';

/** A viewer with `count` drawn pages, each carrying a line of prose. */
function viewerWith(count: number): void {
  const pages = Array.from(
    { length: count },
    (_, i) => `
      <div class="page" data-page-number="${String(i + 1)}">
        <div class="textLayer">
          <span>Page ${String(i + 1)} of a paper about attention and</span>
          <span> transformers, long enough to be worth translating.</span>
        </div>
      </div>`,
  ).join('');
  document.body.innerHTML = `<div id="viewer">${pages}</div>`;
}

function blocks(): number {
  return document.querySelectorAll(`.${PDF_TRANSLATION_CLASS}`).length;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  stopPdfTranslation();
});

describe('translatePdf', () => {
  it('places one translation after each page', async () => {
    viewerWith(2);
    const result = await translatePdf(document, {
      targetLang: 'Traditional Chinese',
      translate: (text) => Promise.resolve(`[zh] ${text}`),
    });

    expect(result.pages).toBe(2);
    expect(blocks()).toBe(2);
    for (const block of document.querySelectorAll(
      `.${PDF_TRANSLATION_CLASS}`,
    )) {
      expect(block.previousElementSibling?.className).toContain('page');
    }
  });

  it('does not translate a page twice while it is still translating', async () => {
    // The defect. A page is marked translated when it *finishes*, and the
    // queue refills from "every drawn page that is not marked" — so a page in
    // flight looks like a page nobody has taken. Milliseconds on a warm run,
    // and the length of a language-pack download on the first one, which is
    // when `e2e:page` finally caught it: two translation blocks after one
    // page, the second one's previous sibling being the first.
    viewerWith(1);

    // A holder rather than a bare `let`: TypeScript cannot see the assignment
    // made inside the executor and narrows the variable to `null` below.
    const gate: { release: (() => void) | null } = { release: null };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    let calls = 0;

    const run = translatePdf(document, {
      targetLang: 'Traditional Chinese',
      translate: async (text) => {
        calls++;
        await held;
        return `[zh] ${text}`;
      },
    });

    // Let the worker take the page and reach its await.
    await Promise.resolve();
    await Promise.resolve();

    // The viewer draws something — a page, a text layer, anything — which is
    // what wakes the observer that refills the queue.
    document
      .getElementById('viewer')
      ?.appendChild(document.createElement('div'));
    // MutationObserver callbacks are microtasks; give them a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    gate.release?.();
    const result = await run;

    expect(blocks()).toBe(1);
    expect(result.pages).toBe(1);
    // And the page was not sent to the model a second time either, which is
    // the cost half of the same bug.
    expect(calls).toBe(1);
  });

  it('leaves nothing behind when cleared', async () => {
    viewerWith(2);
    await translatePdf(document, {
      targetLang: 'Traditional Chinese',
      translate: (text) => Promise.resolve(`[zh] ${text}`),
    });
    clearPdfTranslation(document);
    expect(blocks()).toBe(0);
  });
});

describe('pages the viewer draws later', () => {
  it('translates a page drawn after the first pass has finished', async () => {
    // Pages render lazily — a text layer on 2 of 14 on the viewer's own
    // sample — and the observer that watches for the rest only ever added
    // them to a queue nobody was draining any more. Scrolling on translated
    // nothing past the first screen.
    viewerWith(1);
    const extra = document.createElement('div');
    extra.className = 'page';
    extra.innerHTML = '<div class="textLayer"></div>';
    document.getElementById('viewer')?.appendChild(extra);

    await translatePdf(document, {
      targetLang: 'Traditional Chinese',
      translate: (text) => Promise.resolve(`[zh] ${text}`),
    });
    expect(blocks()).toBe(1);

    const span = document.createElement('span');
    span.textContent = 'A page the reader scrolled to, drawn only just now.';
    extra.querySelector('.textLayer')?.appendChild(span);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(blocks()).toBe(2);
    expect(extra.nextElementSibling?.className).toBe(PDF_TRANSLATION_CLASS);
  });
});

describe('a page drawn as the last worker stops', () => {
  // PDF.js builds a text layer through a chain of promises, so a page can be
  // drawn in any microtask. Between a worker leaving its loop and its count
  // going down, the observer saw a worker still running and left the page
  // queued — and nothing ever looked at the queue again. A little later and
  // the observer started a second run that the first run's finish() then
  // declared done, so the button could no longer stop it.
  it.each(Array.from({ length: 12 }, (_, n) => n))(
    'is translated when drawn %i microtasks after the last translation',
    async (delay) => {
      viewerWith(1);
      const extra = document.createElement('div');
      extra.className = 'page';
      extra.innerHTML = '<div class="textLayer"></div>';
      document.getElementById('viewer')?.appendChild(extra);
      const draw = (): void => {
        const span = document.createElement('span');
        span.textContent = 'A page drawn while the last worker was leaving.';
        extra.querySelector('.textLayer')?.appendChild(span);
      };
      let first = true;

      await translatePdf(document, {
        targetLang: 'Traditional Chinese',
        translate: (text) => {
          if (first) {
            first = false;
            let chain = Promise.resolve();
            for (let i = 0; i < delay; i++) chain = chain.then(() => undefined);
            void chain.then(draw);
          }
          return Promise.resolve(`[zh] ${text}`);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(blocks()).toBe(2);
      expect(
        document.getElementById('oit-page-progress')?.textContent ?? '',
      ).not.toMatch(/Done — 1 pages/);
    },
  );
});

describe('a page where every paragraph failed', () => {
  it('is not marked translated, so the next press tries it again', async () => {
    // Every paragraph throwing — a language pack not there yet, Ollama not
    // running — still marked the page done. The badge said "1 pages
    // translated" over a page with nothing under it, and every later press
    // found "Nothing to translate" until the tab was reloaded.
    viewerWith(1);
    const failed = await translatePdf(document, {
      targetLang: 'Traditional Chinese',
      translate: () => Promise.reject(new Error('engine down')),
    });
    expect(failed.pages).toBe(0);
    expect(document.getElementById('oit-page-progress')?.textContent).toMatch(
      /failed/,
    );

    const retried = await translatePdf(document, {
      targetLang: 'Traditional Chinese',
      translate: (text) => Promise.resolve(`[zh] ${text}`),
    });
    expect(retried.pages).toBe(1);
    expect(blocks()).toBe(1);
  });
});
