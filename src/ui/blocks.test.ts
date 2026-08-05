// @vitest-environment jsdom
/**
 * Block selection is where whole-page translation is won or lost. Every case
 * here is a way the naive version — "every element with text" — makes a page
 * worse: the same paragraph translated three times through its wrappers, a
 * code sample with translated identifiers, a model spending a minute on
 * navigation labels.
 */
import { describe, it, expect } from 'vitest';
import {
  collectBlocks,
  contentRoot,
  visibleText,
  hasTranslatableText,
  isElementVisible,
  MIN_BLOCK_CHARS,
  TRANSLATED_ATTR,
  BILINGUAL_CLASS,
} from './blocks';

const visible = { isVisible: () => true };

function render(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function textsOf(elements: HTMLElement[]): string[] {
  return elements.map((el) => (el.textContent ?? '').trim());
}

describe('hasTranslatableText', () => {
  it('rejects text shorter than the minimum', () => {
    expect(hasTranslatableText('Read more')).toBe(false);
    expect(hasTranslatableText('x'.repeat(MIN_BLOCK_CHARS))).toBe(true);
  });

  it('rejects text with no letters in any script', () => {
    expect(hasTranslatableText('1234567890123456')).toBe(false);
    expect(hasTranslatableText('—— ··· ¶¶¶ §§§ ***')).toBe(false);
    expect(hasTranslatableText('🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉')).toBe(false);
  });

  it('rejects text that is only an address', () => {
    // Found on the Wikipedia article for Ollama: the infobox cell reading
    // `github.com/ollama/ollama` was the one block that failed on every run.
    // It has letters and nothing to translate, so the model returned nothing
    // and the page showed a failure the reader could do nothing about.
    expect(hasTranslatableText('github.com/ollama/ollama')).toBe(false);
    expect(hasTranslatableText('https://ollama.com/download')).toBe(false);
    expect(hasTranslatableText('maintainers@ollama.com')).toBe(false);
  });

  it('keeps a sentence that merely mentions one', () => {
    expect(
      hasTranslatableText('The source lives at github.com/ollama/ollama.'),
    ).toBe(true);
  });

  it('does not mistake ordinary prose for an address', () => {
    // `version 2.5.0` and `e.g.` have no two-letter word after the dot, which
    // is what keeps the host pattern off normal writing.
    expect(
      hasTranslatableText('Upgrade to version 2.5.0 before you begin.'),
    ).toBe(true);
    expect(
      hasTranslatableText('Use a small model, e.g. one of the 8B ones.'),
    ).toBe(true);
  });

  it('accepts non-Latin scripts', () => {
    expect(hasTranslatableText('これは日本語の文章です。')).toBe(true);
    expect(hasTranslatableText('Это предложение на русском.')).toBe(true);
  });

  it('measures after trimming', () => {
    expect(hasTranslatableText(`   \n  short   \n `)).toBe(false);
  });
});

describe('collectBlocks', () => {
  it('collects prose blocks in document order', () => {
    render(`
      <h1>An introduction to the topic</h1>
      <p>The first paragraph of the article body.</p>
      <p>The second paragraph of the article body.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'An introduction to the topic',
      'The first paragraph of the article body.',
      'The second paragraph of the article body.',
    ]);
  });

  it('takes the leaf, not the wrapper that contains it', () => {
    // The wrapper's textContent is its child's. Translating both spends two
    // round trips to print the same sentence twice.
    render(`
      <li><p>A paragraph nested inside a list item.</p></li>
    `);
    const blocks = collectBlocks(document.body, visible);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tagName).toBe('P');
  });

  it('never descends into code, and never translates identifiers', () => {
    render(`
      <pre><code>const translated = "do not touch this string";</code></pre>
      <p>But this explanatory sentence should be translated.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'But this explanatory sentence should be translated.',
    ]);
  });

  it('honours a page asking not to be translated', () => {
    render(`
      <p translate="no">A legal notice that must stay in English.</p>
      <p class="notranslate">A brand name block that must stay put.</p>
      <p>An ordinary paragraph with no such request.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'An ordinary paragraph with no such request.',
    ]);
  });

  it('leaves editable content and form controls alone', () => {
    render(`
      <div contenteditable="true"><p>A draft the user is writing.</p></div>
      <textarea>Some text the user typed into a form.</textarea>
      <p>An ordinary paragraph of page content.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'An ordinary paragraph of page content.',
    ]);
  });

  it('skips short chrome that would still cost a round trip each', () => {
    render(`
      <li>Home</li><li>About</li><li>Contact</li>
      <p>A real sentence of page content, long enough to matter.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'A real sentence of page content, long enough to matter.',
    ]);
  });

  it('skips blocks that already carry a translation', () => {
    render(
      `<p ${TRANSLATED_ATTR}>An already-translated paragraph here.<span class="${BILINGUAL_CLASS}">已經翻譯過的段落。</span></p>`,
    );
    expect(collectBlocks(document.body, visible)).toHaveLength(0);
  });

  it('re-collects a marked block whose translation is gone', () => {
    // How React and Vue reconcile a route change: the element is reused and
    // new text is written into it, which destroys the appended translation
    // and leaves the marker behind. Measured on a real SPA — both blocks kept
    // the marker, neither kept a translation, and the whole-page run reported
    // "Nothing to translate on this page" over untranslated content.
    render(`<p ${TRANSLATED_ATTR}>Brand new text from the next route here.</p>`);
    const collected = collectBlocks(document.body, visible);
    expect(textsOf(collected)).toEqual([
      'Brand new text from the next route here.',
    ]);
    // And the stale claim is dropped rather than left to lie again.
    expect(collected[0]?.hasAttribute(TRANSLATED_ATTR)).toBe(false);
  });

  it('does not treat a descendant translation as this block being done', () => {
    // `:scope >` and not a bare descendant search: a marker on an outer
    // element must be backed by its own translation, not by one further down.
    render(
      `<div ${TRANSLATED_ATTR}><p>Outer block text that was replaced wholesale.<span class="${BILINGUAL_CLASS}">內層譯文。</span></p></div>`,
    );
    const collected = collectBlocks(document.body, visible);
    expect(collected.some((el) => el.tagName === 'DIV')).toBe(false);
  });

  it('never feeds its own injected UI back into itself', () => {
    render(`
      <p>Original paragraph text that was translated already.<span class="oit-bilingual">已經翻譯過的段落文字。</span></p>
      <div id="oit-translate-panel"><div>A panel full of translated text.</div></div>
    `);
    // The paragraph is only excluded by the marker in practice; what this
    // pins is that nothing inside the injected nodes is ever a candidate.
    const collected = collectBlocks(document.body, visible);
    for (const block of collected) {
      expect(block.closest('#oit-translate-panel')).toBeNull();
      expect(block.classList.contains('oit-bilingual')).toBe(false);
    }
  });

  it('drops blocks the visibility test rejects', () => {
    render(`
      <p>A paragraph that the layout says is on screen.</p>
      <p id="hidden">A paragraph inside a collapsed menu.</p>
    `);
    const blocks = collectBlocks(document.body, {
      isVisible: (el) => el.id !== 'hidden',
    });
    expect(textsOf(blocks)).toEqual([
      'A paragraph that the layout says is on screen.',
    ]);
  });

  it('applies the same-language short-circuit when one is given', () => {
    render(`
      <p>An English sentence that needs translating.</p>
      <p>這一段已經是繁體中文，不需要再翻譯。</p>
    `);
    const blocks = collectBlocks(document.body, {
      isVisible: () => true,
      shouldSkipText: (text) => /[一-鿿]/.test(text),
    });
    expect(textsOf(blocks)).toEqual([
      'An English sentence that needs translating.',
    ]);
  });

  it('handles table cells, which carry prose on plenty of pages', () => {
    render(`
      <table><tr>
        <th>The column heading for this table</th>
        <td>A cell containing a full sentence of content.</td>
      </tr></table>
    `);
    expect(collectBlocks(document.body, visible)).toHaveLength(2);
  });

  it('returns nothing for a page with no prose', () => {
    render(`<nav><li>Home</li></nav><script>const x = 1;</script>`);
    expect(collectBlocks(document.body, visible)).toEqual([]);
  });
});

describe('visibleText', () => {
  it('ignores a stylesheet living inside the block', () => {
    // The bug: `textContent` on one Wikipedia reference item returned 2,158
    // characters, 2,100 of them CSS — and the translator rendered `no-repeat`
    // as 無重複 inside a rule set. `closest()` cannot catch this: it looks at
    // ancestors, and the stylesheet is a child.
    render(
      `<li id="ref">Retrieved April 29, 2026.<style>.x{background:url(a.svg) center no-repeat}</style></li>`,
    );
    const li = document.getElementById('ref') as HTMLElement;
    expect(li.textContent).toContain('no-repeat');
    expect(visibleText(li)).toBe('Retrieved April 29, 2026.');
  });

  it('ignores a script for the same reason', () => {
    render(`<p id="p">Real prose.<script>var x = "hidden";</script></p>`);
    expect(visibleText(document.getElementById('p') as HTMLElement)).toBe(
      'Real prose.',
    );
  });

  it('ignores a translation this extension inserted earlier', () => {
    // So a second run reads the original text, not the original plus the
    // first run's output.
    render(
      `<p id="p">The original sentence.<span class="oit-bilingual">原本的句子。</span></p>`,
    );
    expect(visibleText(document.getElementById('p') as HTMLElement)).toBe(
      'The original sentence.',
    );
  });

  it('keeps inline markup, which is part of the sentence', () => {
    render(`<p id="p">A <em>strongly</em> worded <b>claim</b>.</p>`);
    expect(visibleText(document.getElementById('p') as HTMLElement)).toBe(
      'A strongly worded claim.',
    );
  });
});

describe('citations', () => {
  it('leaves a reference list alone, because it is a lookup key', () => {
    // Translated, a bibliography stops working: one real article turned the
    // publisher `Ollama` into 奧拉瑪 and the title "Blog" into "博客".
    render(`
      <ol class="references"><li>Bort, Julie. "Ollama raises $65M". TechCrunch.</li></ol>
      <p>The opening sentence of the actual article.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'The opening sentence of the actual article.',
    ]);
  });

  it('drops a paragraph that is nothing but a citation', () => {
    render(`
      <p><cite>The Structure of Scientific Revolutions, 1962</cite></p>
      <p>The opening sentence of the actual article.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'The opening sentence of the actual article.',
    ]);
  });

  it('keeps the prose of a paragraph that merely cites something', () => {
    render(
      `<p id="p">Kuhn argued this at length in <cite>The Structure of Scientific Revolutions</cite>.</p>`,
    );
    // The sentence is translated; the work's title is left findable.
    expect(visibleText(document.getElementById('p') as HTMLElement)).toBe(
      'Kuhn argued this at length in .',
    );
    expect(collectBlocks(document.body, visible)).toHaveLength(1);
  });
});

describe('navigation chrome', () => {
  it('skips the landmarks a page keeps its chrome in', () => {
    render(`
      <header><p>Create account or log in here</p></header>
      <nav><li>About Wikipedia, and other links</li></nav>
      <aside><p>A sidebar of related reading material.</p></aside>
      <footer><p>Copyright and licensing information here.</p></footer>
      <p>The opening sentence of the actual article.</p>
    `);
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'The opening sentence of the actual article.',
    ]);
  });

  it('skips chrome marked only by ARIA role', () => {
    render(`
      <div role="navigation"><li>Random article link here</li></div>
      <div role="complementary"><p>A tangential box of links.</p></div>
      <p>The opening sentence of the actual article.</p>
    `);
    expect(collectBlocks(document.body, visible)).toHaveLength(1);
  });

  it('skips a table of contents, which is numbers and section names', () => {
    // Left in, this produced the absurd output that exposed the bug: a table
    // of contents entry reading "4" came back translated as "四".
    render(`
      <div class="toc"><li>4 See also and references</li></div>
      <p>The opening sentence of the actual article.</p>
    `);
    expect(collectBlocks(document.body, visible)).toHaveLength(1);
  });
});

describe('contentRoot', () => {
  it('narrows to the landmark a page declares', () => {
    render(`
      <div><p>Chrome that lives outside the main region.</p></div>
      <main><p>The opening sentence of the actual article.</p></main>
    `);
    expect(contentRoot(document.body)).toBe(document.querySelector('main'));
    expect(textsOf(collectBlocks(document.body, visible))).toEqual([
      'The opening sentence of the actual article.',
    ]);
  });

  it('accepts role="main" and article as the same signal', () => {
    render(`<div role="main"><p>The article body lives here.</p></div>`);
    expect(contentRoot(document.body)).toBe(
      document.querySelector('[role="main"]'),
    );
    render(`<article><p>The article body lives here.</p></article>`);
    expect(contentRoot(document.body)).toBe(document.querySelector('article'));
  });

  it('falls back to the whole page when none is declared', () => {
    // example.com and most hand-written HTML. Narrowing to nothing would
    // translate nothing.
    render(`<p>A page with no landmark at all, just text.</p>`);
    expect(contentRoot(document.body)).toBe(document.body);
    expect(collectBlocks(document.body, visible)).toHaveLength(1);
  });

  it('still filters chrome that a page nests inside its main region', () => {
    render(`
      <main>
        <nav><li>An in-content navigation strip here</li></nav>
        <p>The opening sentence of the actual article.</p>
      </main>
    `);
    expect(collectBlocks(document.body, visible)).toHaveLength(1);
  });
});

describe('isElementVisible', () => {
  // jsdom does no layout, so both signals are stubbed. What is being pinned is
  // the policy, not the engine: which of the two signals is allowed to decide.
  function element(
    offsetParent: unknown,
    rect: { width: number; height: number },
  ): HTMLElement {
    const el = document.createElement('p');
    Object.defineProperty(el, 'offsetParent', { value: offsetParent });
    el.getBoundingClientRect = () => rect as DOMRect;
    return el;
  }

  it('accepts anything the layout placed', () => {
    expect(isElementVisible(element({}, { width: 0, height: 0 }))).toBe(true);
  });

  it('rejects an element with no offset parent and no size', () => {
    expect(isElementVisible(element(null, { width: 0, height: 0 }))).toBe(
      false,
    );
  });

  it('accepts a fixed-position element, which reports no offset parent', () => {
    // Sticky headers and floating asides are `position: fixed`; treating a null
    // offsetParent as hidden would skip visible page content.
    expect(isElementVisible(element(null, { width: 300, height: 40 }))).toBe(
      true,
    );
  });
});
