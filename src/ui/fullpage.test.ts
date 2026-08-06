// @vitest-environment jsdom
/**
 * Whole-page translation drives dozens of requests against a single local
 * server while the user watches. The properties worth pinning are not "does it
 * translate" — they are the ones that decide whether a page is usable
 * afterwards: the original survives, one failure does not take the page with
 * it, stopping actually stops, and running twice does not translate anything
 * twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  showPageNotice,
  translatePage,
  togglePageTranslation,
  clearPageTranslation,
  isPageTranslated,
  stopPageTranslation,
  BILINGUAL_CLASS,
  PROGRESS_ID,
  CONCURRENCY,
  GIVE_UP_AFTER,
  type PageTranslateDeps,
} from './fullpage';
import { TRANSLATED_ATTR } from './blocks';

const PAGE = `
  <h1>An introduction to the topic</h1>
  <p id="a">The first paragraph of the article body.</p>
  <p id="b">The second paragraph of the article body.</p>
`;

function deps(overrides: Partial<PageTranslateDeps> = {}): PageTranslateDeps {
  return {
    targetLang: 'Traditional Chinese',
    isVisible: () => true,
    translate: (text: string) => Promise.resolve(`[zh] ${text}`),
    ...overrides,
  };
}

function translations(): string[] {
  return Array.from(document.querySelectorAll(`.${BILINGUAL_CLASS}`)).map(
    (node) => node.textContent ?? '',
  );
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
  vi.useFakeTimers();
});

afterEach(() => {
  stopPageTranslation();
  vi.useRealTimers();
});

describe('translatePage', () => {
  it('appends a translation to each block without touching the original', async () => {
    const result = await translatePage(document, deps());

    expect(result).toEqual({
      translated: 3,
      failed: 0,
      unchanged: 0,
      stopped: false,
    });
    const first = document.getElementById('a');
    // The original text is still the first child; the translation is beside
    // it, not over it. A local model is good, not perfect — a reader has to
    // be able to check a sentence that looks wrong.
    expect(first?.firstChild?.textContent).toBe(
      'The first paragraph of the article body.',
    );
    expect(first?.querySelector(`.${BILINGUAL_CLASS}`)?.textContent).toBe(
      '[zh] The first paragraph of the article body.',
    );
  });

  it('marks the target language on what it inserts, as BCP-47', async () => {
    await translatePage(document, deps());
    const node = document.querySelector<HTMLElement>(`.${BILINGUAL_CLASS}`);
    // Not "Traditional Chinese", which is what this shipped for five releases
    // and what `Intl.getCanonicalLocales` throws a RangeError on. A screen
    // reader cannot resolve a display name to a voice.
    expect(node?.lang).toBe('zh-Hant');
    expect(() => Intl.getCanonicalLocales(node?.lang ?? '')).not.toThrow();
    expect(node?.getAttribute('dir')).toBe('auto');
  });

  it('leaves lang off entirely when the target maps to no BCP-47 tag', async () => {
    // No tag inherits the page's language; a made-up one asserts something
    // false, which is worse.
    await translatePage(document, deps({ targetLang: 'Klingon' }));
    const node = document.querySelector<HTMLElement>(`.${BILINGUAL_CLASS}`);
    expect(node?.hasAttribute('lang')).toBe(false);
  });

  it('keeps going when one block fails, and says how many did', async () => {
    const result = await translatePage(
      document,
      deps({
        translate: (text) =>
          text.includes('second')
            ? Promise.reject(new Error('model exploded'))
            : Promise.resolve(`[zh] ${text}`),
      }),
    );

    expect(result.translated).toBe(2);
    expect(result.failed).toBe(1);
    // A page is not all-or-nothing: the two that worked are readable, and the
    // one that did not says so rather than silently looking untranslated.
    expect(
      document.querySelector('#b .' + BILINGUAL_CLASS)?.textContent,
    ).toContain('failed');
  });

  it('puts the reason in the summary rather than throwing it away', async () => {
    // The broker produces something a user can act on. This path used to
    // discard it and print "translation failed" once per block — twenty-eight
    // identical lines, none of them saying what to do.
    const result = await translatePage(
      document,
      deps({
        translate: () =>
          Promise.reject(
            new Error(
              "Can't reach Ollama at http://127.0.0.1:1. Is the server running?",
            ),
          ),
      }),
    );
    expect(result.failed).toBe(3);
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain(
      "Can't reach Ollama",
    );
  });

  it('says nothing extra when nothing failed', async () => {
    await translatePage(document, deps());
    const badge = document.getElementById(PROGRESS_ID)?.textContent ?? '';
    expect(badge).toContain('3 translated');
    expect(badge).not.toContain('—  ');
  });

  it('treats an empty generation as a failure, not as success', async () => {
    // Silently skipping it leaves a gap the reader reads as "already in my
    // language", which is worse than an error.
    const result = await translatePage(
      document,
      deps({ translate: () => Promise.resolve('   ') }),
    );
    expect(result).toEqual({
      translated: 0,
      failed: 3,
      unchanged: 0,
      stopped: false,
    });
    expect(translations().every((t) => t.includes('no translation'))).toBe(
      true,
    );
  });

  it('runs the first block alone, then opens to CONCURRENCY', async () => {
    // Ramp-up. A second request racing a cold model load does not arrive any
    // sooner; it only lengthens the queue while the same load happens, and the
    // cold burst is where failures cluster on a real page.
    let inFlight = 0;
    const peaks: number[] = [];
    const release: (() => void)[] = [];

    const run = translatePage(
      document,
      deps({
        translate: (text) => {
          inFlight++;
          peaks.push(inFlight);
          return new Promise<string>((resolve) => {
            release.push(() => {
              inFlight--;
              resolve(`[zh] ${text}`);
            });
          });
        },
      }),
    );

    await Promise.resolve();
    // Exactly one in flight while the model may still be loading.
    expect(inFlight).toBe(1);

    release.shift()?.();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(inFlight).toBe(CONCURRENCY);

    for (let i = 0; i < 10 && release.length > 0; i++) {
      release.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await run;
    expect(Math.max(...peaks)).toBe(CONCURRENCY);
  });

  it('stops when asked, keeping what already landed', async () => {
    let started = 0;
    const run = translatePage(
      document,
      deps({
        translate: (text, signal) =>
          new Promise<string>((resolve, reject) => {
            started++;
            if (started === 1) {
              resolve(`[zh] ${text}`);
              return;
            }
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    stopPageTranslation();
    const result = await run;

    expect(result.stopped).toBe(true);
    expect(result.translated).toBe(1);
    // A stop is not an undo. What was already translated stays readable.
    expect(translations()).toHaveLength(1);
  });

  it('retries once when the model returns nothing', async () => {
    // The selection path has always retried; this one never did, so a single
    // empty generation printed a failure onto the page for good.
    const attempts: number[] = [];
    const result = await translatePage(
      document,
      deps({
        translate: (text, _signal, attempt) => {
          attempts.push(attempt);
          return Promise.resolve(attempt === 0 ? '' : `[zh] ${text}`);
        },
      }),
    );
    expect(result).toEqual({
      translated: 3,
      failed: 0,
      unchanged: 0,
      stopped: false,
    });
    // Order-independent: once the ramp-up opens, two workers interleave.
    // What matters is that every block got a first try and exactly one retry.
    expect(attempts.filter((a) => a === 0)).toHaveLength(3);
    expect(attempts.filter((a) => a === 1)).toHaveLength(3);
  });

  it('gives up after the retry rather than looping', async () => {
    const result = await translatePage(
      document,
      deps({ translate: () => Promise.resolve('') }),
    );
    expect(result.failed).toBe(3);
  });

  it('does not translate the same block twice across two runs', async () => {
    await translatePage(document, deps());
    expect(translations()).toHaveLength(3);

    const seen: string[] = [];
    const second = await translatePage(
      document,
      deps({
        translate: (text) => {
          seen.push(text);
          return Promise.resolve(`[zh] ${text}`);
        },
      }),
    );

    // Nothing new on the page, so a second run is a no-op rather than a
    // duplicate — which also makes this the right way to pick up content that
    // loaded after the first pass.
    expect(seen).toEqual([]);
    expect(second.translated).toBe(0);
    expect(translations()).toHaveLength(3);
  });

  it('re-translates a block whose text was replaced under it', async () => {
    // An SPA route change, as React and Vue perform one: the element is
    // reused and new text is written into it, which destroys the appended
    // translation while leaving the marker behind. Verified in a real browser
    // before this fix — the badge read "Nothing to translate on this page"
    // over two fully untranslated paragraphs.
    await translatePage(document, deps());
    expect(translations()).toHaveLength(3);

    const reused = document.getElementById('a');
    if (reused) reused.textContent = 'The next route says something else here.';
    expect(reused?.hasAttribute(TRANSLATED_ATTR)).toBe(true);

    const seen: string[] = [];
    const second = await translatePage(
      document,
      deps({
        translate: (text) => {
          seen.push(text);
          return Promise.resolve(`[zh] ${text}`);
        },
      }),
    );

    expect(seen).toEqual(['The next route says something else here.']);
    expect(second.translated).toBe(1);
    expect(reused?.querySelector(`.${BILINGUAL_CLASS}`)?.textContent).toBe(
      '[zh] The next route says something else here.',
    );
  });

  it('picks up blocks that appeared after the first run', async () => {
    await translatePage(document, deps());
    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph that loaded after the first pass.';
    document.body.appendChild(fresh);

    const result = await translatePage(document, deps());
    expect(result.translated).toBe(1);
    expect(translations()).toHaveLength(4);
  });

  it('reports an empty page instead of pretending to work', async () => {
    document.body.innerHTML = '<nav><li>Home</li></nav>';
    const result = await translatePage(document, deps());
    expect(result).toEqual({
      translated: 0,
      failed: 0,
      unchanged: 0,
      stopped: false,
    });
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain(
      'Nothing to translate',
    );
  });

  it('says when it is downloading a language pack', async () => {
    // Two minutes of silence on the first use of a language pair is the bug
    // this replaces: the badge sat at "Translating 0/3" and looked stuck.
    let release: (value: string) => void = () => undefined;
    const run = translatePage(
      document,
      deps({
        translate: (text, _signal, _attempt, onDownload) => {
          onDownload?.(0.42);
          // Held open: in a real run the pack finishes downloading before the
          // translation resolves, and the block counter then takes the badge
          // back over. Resolving here immediately would race that.
          return new Promise<string>((resolve) => {
            release = () => resolve(`[zh] ${text}`);
          });
        },
      }),
    );
    await Promise.resolve();
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain(
      'Downloading language pack 42%',
    );

    stopPageTranslation();
    release('');
    await run;
  });

  it('shows progress while running and a summary at the end', async () => {
    const run = translatePage(document, deps());
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain(
      'Translating',
    );
    await run;
    const badge = document.getElementById(PROGRESS_ID);
    expect(badge?.textContent).toContain('3 translated');
    // The Stop button is gone once there is nothing to stop.
    expect(badge?.querySelector('button')).toBeNull();
  });

  it('announces the badge, since the corner of the screen is not universal', () => {
    void translatePage(document, deps());
    const badge = document.getElementById(PROGRESS_ID);
    expect(badge?.getAttribute('role')).toBe('status');
    expect(badge?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('clearPageTranslation', () => {
  it('removes every insertion and every marker', async () => {
    await translatePage(document, deps());
    expect(clearPageTranslation(document)).toBe(3);

    expect(translations()).toEqual([]);
    expect(document.querySelectorAll(`[${TRANSLATED_ATTR}]`)).toHaveLength(0);
    // Back to the original page, byte for byte in the parts that matter.
    expect(document.getElementById('a')?.textContent).toBe(
      'The first paragraph of the article body.',
    );
  });
});

describe('togglePageTranslation', () => {
  it('translates, then undoes, on successive calls', async () => {
    await togglePageTranslation(document, deps());
    expect(isPageTranslated(document)).toBe(true);

    await togglePageTranslation(document, deps());
    expect(isPageTranslated(document)).toBe(false);
    expect(document.getElementById(PROGRESS_ID)).toBeNull();
  });

  it('retranslates in one press after the target language changes', async () => {
    // Reported from use: translate a page, switch language in the popup, press
    // translate — and the page was erased instead. A second press then did the
    // translation, so switching language cost two presses and the first one
    // looked like the feature breaking.
    await togglePageTranslation(document, deps());
    expect(
      document.querySelector<HTMLElement>(`.${BILINGUAL_CLASS}`)?.lang,
    ).toBe('zh-Hant');

    const seen: string[] = [];
    const result = await togglePageTranslation(
      document,
      deps({
        targetLang: 'Japanese',
        translate: (text) => {
          seen.push(text);
          return Promise.resolve(`[ja] ${text}`);
        },
      }),
    );

    expect(result?.translated).toBe(3);
    expect(seen).toHaveLength(3);
    expect(isPageTranslated(document)).toBe(true);
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(`.${BILINGUAL_CLASS}`),
    );
    expect(nodes.every((n) => n.lang === 'ja')).toBe(true);
    // And nothing from the old language survived alongside it.
    expect(nodes.every((n) => n.textContent?.startsWith('[ja]'))).toBe(true);
  });

  it('still undoes when the language has not changed', async () => {
    await togglePageTranslation(document, deps());
    expect(await togglePageTranslation(document, deps())).toBeNull();
    expect(isPageTranslated(document)).toBe(false);
  });

  it('undoes rather than guessing when the target maps to no tag', async () => {
    // Nothing on the page says what language it is in, so "unknown" must not
    // be read as "wrong" and quietly retranslate a page asked to be cleared.
    const custom = deps({ targetLang: 'Klingon' });
    await togglePageTranslation(document, custom);
    expect(isPageTranslated(document)).toBe(true);

    expect(await togglePageTranslation(document, custom)).toBeNull();
    expect(isPageTranslated(document)).toBe(false);
  });

  it('stops a run in progress rather than starting a second one', async () => {
    let calls = 0;
    const run = translatePage(
      document,
      deps({
        translate: (text, signal) =>
          new Promise<string>((resolve, reject) => {
            calls++;
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
            if (calls > 99) resolve(text);
          }),
      }),
    );
    await Promise.resolve();

    expect(await togglePageTranslation(document, deps())).toBeNull();
    await run;
    // One, not CONCURRENCY: the ramp-up means only the first block had
    // started when the toggle stopped the run.
    expect(calls).toBe(1);
  });
});

describe('showPageNotice', () => {
  it('says why, where progress would otherwise appear', () => {
    // The PDF viewer offers "translate this page" through the context menu
    // like anywhere else, and cannot do it — a text layer is absolutely
    // positioned lines, so an inserted translation lands on the next one.
    // Doing nothing was worse than refusing.
    showPageNotice(document, 'Not available here.');
    const badge = document.getElementById(PROGRESS_ID);
    expect(badge?.textContent).toContain('Not available here.');
    // Nothing to stop, so no Stop button.
    expect(badge?.querySelector('button')).toBeNull();
  });

  it('replaces an earlier notice instead of stacking them', () => {
    showPageNotice(document, 'First.');
    showPageNotice(document, 'Second.');
    expect(document.querySelectorAll(`#${PROGRESS_ID}`)).toHaveLength(1);
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain(
      'Second.',
    );
  });
});

describe('a page already in the target language', () => {
  it('inserts nothing when the engine hands the text straight back', async () => {
    // Both engines answer "translate this into the language it is already in"
    // by returning the text verbatim — the honest answer in the selection
    // panel, and a duplicate of every paragraph here. Measured on the English
    // Wikipedia article with English as the target: 28 blocks, all 28 returned
    // byte-identical, the whole article printed twice.
    const result = await translatePage(
      document,
      deps({
        targetLang: 'English',
        translate: (text) => Promise.resolve(text),
      }),
    );

    expect(result).toEqual({
      translated: 0,
      failed: 0,
      unchanged: 3,
      stopped: false,
    });
    expect(translations()).toEqual([]);
    expect(document.body.innerText ?? document.body.textContent).not.toContain(
      'The first paragraph of the article body.The first paragraph',
    );
  });

  it('says why nothing happened rather than "0 translated"', async () => {
    await translatePage(
      document,
      deps({
        targetLang: 'English',
        translate: (text) => Promise.resolve(text),
      }),
    );
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain(
      'already in English',
    );
  });

  it('leaves those blocks unmarked, so a later run can try again', async () => {
    // Deliberate. Marking them would save the second pass, but the marker
    // means "a translation is appended below this block", and 2.7.7 exists
    // because a marker without one is treated as stale — an SPA had wiped the
    // translation out from under it. Two meanings for one attribute is how
    // that bug comes back, and repeating a pass that inserts nothing is a
    // cheaper thing to be wrong about.
    await translatePage(
      document,
      deps({
        targetLang: 'English',
        translate: (text) => Promise.resolve(text),
      }),
    );
    expect(document.querySelectorAll(`[${TRANSLATED_ATTR}]`)).toHaveLength(0);

    const seen: string[] = [];
    const second = await translatePage(
      document,
      deps({
        targetLang: 'English',
        translate: (text) => {
          seen.push(text);
          return Promise.resolve(text);
        },
      }),
    );
    expect(seen).toHaveLength(3);
    expect(second.unchanged).toBe(3);
    expect(translations()).toEqual([]);
  });

  it('keeps a block whose translation differs by more than whitespace', async () => {
    const result = await translatePage(
      document,
      deps({ translate: (text) => Promise.resolve(`  ${text} 。 `) }),
    );
    expect(result.translated).toBe(3);
    expect(result.unchanged).toBe(0);
  });
});

describe('a run that is going nowhere', () => {
  const PAGE_OF_TEN = Array.from(
    { length: 10 },
    (_, i) => `<p>Paragraph number ${String(i)} of the article body here.</p>`,
  ).join('');

  it('gives up after three consecutive failures instead of marking the page', async () => {
    // With Ollama not running every block fails the same way. The old
    // behaviour marked all of them — on a real article, twenty-eight ⚠️ lines
    // for one problem that was obvious by the third, all of which the reader
    // then had to clear.
    document.body.innerHTML = PAGE_OF_TEN;
    let calls = 0;
    const result = await translatePage(
      document,
      deps({
        translate: () => {
          calls++;
          return Promise.reject(
            new Error("Can't reach Ollama at http://localhost:11434."),
          );
        },
      }),
    );

    // Not exactly GIVE_UP_AFTER: two requests are in flight at a time, so the
    // one that was already sent when the third failure landed still comes
    // back. What matters is that it stopped near the top instead of marking
    // all ten.
    expect(calls).toBeGreaterThanOrEqual(GIVE_UP_AFTER);
    expect(calls).toBeLessThanOrEqual(GIVE_UP_AFTER + CONCURRENCY);
    expect(result.translated).toBe(0);
    // Nothing left behind to clean up.
    expect(document.querySelectorAll(`.${BILINGUAL_CLASS}`)).toHaveLength(0);
    expect(document.querySelectorAll(`[${TRANSLATED_ATTR}]`)).toHaveLength(0);
  });

  it('says why it gave up, once', async () => {
    document.body.innerHTML = PAGE_OF_TEN;
    await translatePage(
      document,
      deps({
        translate: () =>
          Promise.reject(
            new Error("Can't reach Ollama at http://localhost:11434."),
          ),
      }),
    );
    const badge = document.getElementById(PROGRESS_ID)?.textContent ?? '';
    expect(badge).toContain('Gave up');
    expect(badge).toContain("Can't reach Ollama");
  });

  it('is not reported as the user having stopped it', async () => {
    document.body.innerHTML = PAGE_OF_TEN;
    const result = await translatePage(
      document,
      deps({ translate: () => Promise.reject(new Error('down')) }),
    );
    expect(result.stopped).toBe(false);
  });

  it('keeps going when failures are scattered rather than consecutive', async () => {
    // One bad block is bad luck, and the counter resets on anything that works.
    document.body.innerHTML = PAGE_OF_TEN;
    let n = 0;
    const result = await translatePage(
      document,
      deps({
        translate: (text) => {
          n++;
          return n % 2 === 0
            ? Promise.reject(new Error('one bad block'))
            : Promise.resolve(`[zh] ${text}`);
        },
      }),
    );

    expect(result.translated).toBe(5);
    expect(result.failed).toBe(5);
    expect(document.getElementById(PROGRESS_ID)?.textContent).toContain('Done');
  });

  it('leaves the translations it did manage before giving up', async () => {
    document.body.innerHTML = PAGE_OF_TEN;
    let n = 0;
    await translatePage(
      document,
      deps({
        translate: (text) => {
          n++;
          return n <= 2
            ? Promise.resolve(`[zh] ${text}`)
            : Promise.reject(new Error('the server went away'));
        },
      }),
    );

    expect(translations()).toHaveLength(2);
    expect(translations().every((t) => t.startsWith('[zh]'))).toBe(true);
  });
});
