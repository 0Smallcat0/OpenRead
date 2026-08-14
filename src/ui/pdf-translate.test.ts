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
