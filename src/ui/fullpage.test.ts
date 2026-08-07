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
import {
  applyAppearance,
  reflowTranslations,
  ORIGINAL_CLASS,
} from './fullpage';

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

  it('says nothing about an empty page when nobody asked', async () => {
    // An automatic pass on page load. A press that appears to do nothing looks
    // broken and is answered; an unprompted one that finds nothing has nothing
    // to report — and on an app that renders after load it would find nothing
    // on every navigation, so the notice would be constant.
    document.body.innerHTML = '<nav><li>Home</li></nav>';
    const result = await translatePage(
      document,
      deps({ unprompted: true } as Partial<PageTranslateDeps>),
    );

    expect(result.translated).toBe(0);
    expect(document.getElementById(PROGRESS_ID)).toBeNull();
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

  it('does not sit at 0% while a download has not reported anything', async () => {
    // The monitor's granularity is not something a caller can rely on: 479
    // events for one pair, and exactly two — 0 then 1 — for another that took
    // 81 seconds. "0%" held for a minute and a half reads as stuck, which is
    // the impression this line exists to prevent.
    let release: (value: string) => void = () => undefined;
    const run = translatePage(
      document,
      deps({
        translate: (text, _signal, _attempt, onDownload) => {
          onDownload?.(0);
          return new Promise<string>((resolve) => {
            release = () => resolve(`[zh] ${text}`);
          });
        },
      }),
    );
    await Promise.resolve();
    const badge = document.getElementById(PROGRESS_ID)?.textContent ?? '';
    expect(badge).toContain('Downloading language pack');
    expect(badge).not.toContain('0%');

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

  it('keeps what the reader had when they press Stop during the wait', async () => {
    await togglePageTranslation(document, deps());

    const run = togglePageTranslation(
      document,
      deps({
        targetLang: 'Japanese',
        // Never resolves: the pack download the reader is waiting through.
        translate: () => new Promise<string>(() => undefined),
      }),
    );
    await Promise.resolve();
    document
      .querySelector<HTMLButtonElement>('#oit-page-progress button')
      ?.click();

    expect(await run).toBeNull();
    // Not erased. Stopping a wait is not a request to lose what was on screen.
    const kept = Array.from(
      document.querySelectorAll<HTMLElement>(`.${BILINGUAL_CLASS}`),
    );
    expect(kept).toHaveLength(3);
    expect(kept.every((n) => n.lang === 'zh-Hant')).toBe(true);
  });

  it('keeps the old translation up while the new engine is still warming', async () => {
    await togglePageTranslation(document, deps());
    expect(isPageTranslated(document)).toBe(true);

    let release: (value: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    let first = true;
    const run = togglePageTranslation(
      document,
      deps({
        targetLang: 'Japanese',
        translate: (text) => {
          if (!first) return Promise.resolve(`[ja] ${text}`);
          first = false;
          return pending;
        },
      }),
    );
    await Promise.resolve();

    // The pack is still downloading. What the reader had must still be there.
    const during = document.querySelectorAll(`.${BILINGUAL_CLASS}`);
    expect(during).toHaveLength(3);
    expect(during[0]?.getAttribute('lang')).toBe('zh-Hant');

    release('warm');
    await run;
    const after = Array.from(
      document.querySelectorAll<HTMLElement>(`.${BILINGUAL_CLASS}`),
    );
    expect(after.every((n) => n.lang === 'ja')).toBe(true);
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
    // Four calls for three blocks. The extra one comes first and its result is
    // thrown away: it is what makes Chrome fetch the language pack for the new
    // pair *before* the old translation is taken off the page. Clearing first
    // left the reader looking at a bare page for up to two minutes, which is
    // what the download costs, and read as the extension hanging.
    expect(seen).toHaveLength(4);
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

  it('leaves an automatic pass alone rather than aborting it', async () => {
    // Measured in a real browser: automatic translation on, page loads,
    // the button pressed a moment later — and the page ended with zero blocks
    // translated. The control labelled "translate this page" produced no
    // translation at all, because the toggle read "running" as "stop".
    const release: (() => void)[] = [];
    const run = translatePage(
      document,
      deps({
        unprompted: true,
        translate: (text) =>
          new Promise<string>((resolve) => {
            release.push(() => {
              resolve(`[zh] ${text}`);
            });
          }),
      } as Partial<PageTranslateDeps>),
    );
    await Promise.resolve();

    expect(await togglePageTranslation(document, deps())).toBeNull();
    for (let i = 0; i < 20 && release.length > 0; i++) {
      release.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await run;

    // Still running, and still going to finish. Stopping something you did not
    // start belongs on the badge's own Stop button.
    expect(translations().length).toBeGreaterThan(0);
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

/**
 * The properties that make a page stay translated rather than be translated
 * once. jsdom has no IntersectionObserver and lays nothing out, so both are
 * supplied here: the fake below records what was handed to it and lets a test
 * say "the reader has now scrolled to this", and `place` gives an element the
 * rectangle jsdom will not compute.
 */
class FakeIntersectionObserver {
  static live: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(
    private readonly notify: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.live.push(this);
  }
  observe(element: Element): void {
    this.observed.add(element);
  }
  unobserve(element: Element): void {
    this.observed.delete(element);
  }
  disconnect(): void {
    this.observed.clear();
  }
  /** The reader has scrolled these into range. */
  arrive(...elements: Element[]): void {
    this.notify(
      elements.map((target) => ({
        target,
        isIntersecting: true,
      })) as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

/** Put an element at `top` in viewport coordinates. jsdom reports zeros. */
function place(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + 20,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('keeping a page translated', () => {
  /** The observer the code under test built, if it built one. */
  const observer = (): FakeIntersectionObserver => {
    const last = FakeIntersectionObserver.live.at(-1);
    if (!last) throw new Error('nothing observed the viewport');
    return last;
  };

  /** Let the debounce, the follow-up run and their microtasks all settle. */
  const settle = async (ms = 1200): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  const spy = (
    seen: string[],
  ): Pick<PageTranslateDeps, 'translate'>['translate'] => {
    return (text: string) => {
      seen.push(text);
      return Promise.resolve(`[zh] ${text}`);
    };
  };

  beforeEach(() => {
    FakeIntersectionObserver.live = [];
    (
      window as unknown as { IntersectionObserver: unknown }
    ).IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    delete (window as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver;
  });

  it('translates what the reader can see and defers the rest', async () => {
    // The measurement this exists for: the English Wikipedia article on
    // artificial intelligence offers 308 blocks and shows about five. The other
    // 303 are the reader's battery spent on text they may never scroll to.
    document.body.innerHTML = `
      <p id="near">A paragraph the reader can see right now.</p>
      <p id="far">A paragraph a long way down the page.</p>
    `;
    const far = document.getElementById('far');
    if (far) place(far, 5000);

    const seen: string[] = [];
    const result = await translatePage(
      document,
      deps({ translate: spy(seen) }),
    );

    expect(result.translated).toBe(1);
    expect(seen).toEqual(['A paragraph the reader can see right now.']);
    // Not dropped — handed to the observer, to be translated on arrival.
    expect(far && observer().observed.has(far)).toBe(true);
  });

  it('translates a deferred block when the reader scrolls to it', async () => {
    document.body.innerHTML = `
      <p id="near">A paragraph the reader can see right now.</p>
      <p id="far">A paragraph a long way down the page.</p>
    `;
    const far = document.getElementById('far');
    if (far) place(far, 5000);

    const seen: string[] = [];
    await translatePage(document, deps({ translate: spy(seen) }));
    if (far) observer().arrive(far);
    await settle();

    expect(seen).toContain('A paragraph a long way down the page.');
    expect(far?.querySelector(`.${BILINGUAL_CLASS}`)?.textContent).toBe(
      '[zh] A paragraph a long way down the page.',
    );
    // And it is not offered a second time on the next scroll past it.
    expect(far && observer().observed.has(far)).toBe(false);
  });

  it('translates content the page adds later, without another press', async () => {
    // An infinite feed, a comment thread expanding, an SPA swapping a route.
    // Every one of those used to need a keypress per screen.
    const seen: string[] = [];
    await translatePage(document, deps({ translate: spy(seen) }));
    expect(seen).toHaveLength(3);

    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph the feed appended after the first pass.';
    document.body.appendChild(fresh);
    await settle();

    expect(fresh.querySelector(`.${BILINGUAL_CLASS}`)?.textContent).toBe(
      '[zh] A paragraph the feed appended after the first pass.',
    );
  });

  it('stays quiet once a page is done', async () => {
    // Every translation is itself a mutation. Answering our own insertions
    // would run the collector once per block and re-badge a finished page.
    const seen: string[] = [];
    await translatePage(document, deps({ translate: spy(seen) }));
    document.getElementById(PROGRESS_ID)?.remove();
    await settle();

    expect(seen).toHaveLength(3);
    expect(document.getElementById(PROGRESS_ID)).toBeNull();
  });

  it('stops watching when the translation is cleared', async () => {
    // Undo has to mean undo. Observers that survived it would read the removals
    // as the page changing and put the translation straight back.
    const seen: string[] = [];
    await translatePage(document, deps({ translate: spy(seen) }));
    clearPageTranslation(document);

    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph that arrived after the undo.';
    document.body.appendChild(fresh);
    await settle();

    expect(seen).toHaveLength(3);
    expect(translations()).toEqual([]);
  });

  it('stops watching when the user presses Stop', async () => {
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
    await run;

    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph that arrived after the stop.';
    document.body.appendChild(fresh);
    await settle();

    expect(fresh.querySelector(`.${BILINGUAL_CLASS}`)).toBeNull();
  });

  it('stops watching after it gives up, rather than retrying every screen', async () => {
    document.body.innerHTML = Array.from(
      { length: 10 },
      (_, i) =>
        `<p>Paragraph number ${String(i)} of the article body here.</p>`,
    ).join('');
    let calls = 0;
    await translatePage(
      document,
      deps({
        translate: () => {
          calls++;
          return Promise.reject(new Error("Can't reach Ollama."));
        },
      }),
    );
    const gaveUpAfter = calls;

    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph that arrived after it gave up.';
    document.body.appendChild(fresh);
    await settle();

    // Otherwise a broken engine is asked again once per screen scrolled, and
    // each round leaves its own ⚠️ debris and its own badge.
    expect(calls).toBe(gaveUpAfter);
  });

  it('does not queue a block twice when the page changes mid-run', async () => {
    // A rescan that lands mid-run re-collects every block still waiting its
    // turn, because a block that has not been reached yet is untranslated and
    // looks exactly like new work. Found by following the badge's own label
    // text back to a rescan it should never have caused.
    document.body.innerHTML = Array.from(
      { length: 5 },
      (_, i) =>
        `<p>Paragraph number ${String(i)} of the article body here.</p>`,
    ).join('');

    const seen: string[] = [];
    let release: (() => void) | null = null;
    const run = translatePage(
      document,
      deps({
        translate: (text) => {
          seen.push(text);
          if (seen.length > 1) return Promise.resolve(`[zh] ${text}`);
          // Held open, so the other four are still in the queue below.
          return new Promise<string>((resolve) => {
            release = () => {
              resolve(`[zh] ${text}`);
            };
          });
        },
      }),
    );
    await Promise.resolve();

    document.body.appendChild(document.createElement('hr'));
    await vi.advanceTimersByTimeAsync(400);
    (release as (() => void) | null)?.();
    await run;

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(translations()).toHaveLength(5);
  });

  it('does not re-offer a block the engine handed back unchanged', async () => {
    // Those are left unmarked on purpose, so a later press can retry them —
    // which means every rescan collects them again. One page of proper nouns
    // was one infinite loop.
    const seen: string[] = [];
    await translatePage(
      document,
      deps({
        translate: (text) => {
          seen.push(text);
          return Promise.resolve(text);
        },
      }),
    );
    expect(seen).toHaveLength(3);
    // Nothing inserted and nothing marked: the page is already in the target
    // language as far as the engine is concerned.
    expect(translations()).toEqual([]);

    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph that arrived after the first pass.';
    document.body.appendChild(fresh);
    await settle();

    // The new paragraph, and only the new paragraph.
    expect(seen).toHaveLength(4);
    expect(seen.at(-1)).toBe('A paragraph that arrived after the first pass.');
  });

  it('keeps watching when a route change replaces the whole body', async () => {
    // How React and Vue swap a route at the top level. An observer attached to
    // the old body is left watching a node that is no longer in the document:
    // measured in a real browser before this fix, route A translated and route
    // B stayed English no matter how far it was scrolled.
    const seen: string[] = [];
    await translatePage(document, deps({ translate: spy(seen) }));
    expect(seen).toHaveLength(3);

    const next = document.createElement('body');
    const fresh = document.createElement('p');
    fresh.id = 'route-b';
    fresh.textContent = 'The next route says something else here.';
    next.appendChild(fresh);
    document.documentElement.replaceChild(next, document.body);
    await settle();

    expect(fresh.querySelector(`.${BILINGUAL_CLASS}`)?.textContent).toBe(
      '[zh] The next route says something else here.',
    );
  });

  it('does not re-collect the page for its own selection panel', async () => {
    // `collectBlocks` asks `isVisible` about every candidate, so counting those
    // counts collections. Two copies of "our own UI" had drifted apart — the
    // one here was missing the selection panel and the floating icon — so
    // opening a panel, or every token of a streamed translation inside one,
    // read as the page growing new text.
    // The engine hands every block back unchanged, so none of them ends up
    // carrying a translation — which matters, because `collectBlocks` returns
    // early on a block that does, before it ever asks about visibility.
    let visibilityChecks = 0;
    await translatePage(
      document,
      deps({
        translate: (text) => Promise.resolve(text),
        isVisible: () => {
          visibilityChecks++;
          return true;
        },
      }),
    );
    const afterRun = visibilityChecks;

    const panel = document.createElement('div');
    panel.id = 'oit-translate-panel';
    document.body.appendChild(panel);
    for (let i = 0; i < 5; i++) {
      panel.textContent = `streaming a translation, token ${String(i)}`;
    }
    await settle();
    expect(visibilityChecks).toBe(afterRun);

    // The control: ordinary new content still re-collects, so the count above
    // is measuring something.
    const fresh = document.createElement('p');
    fresh.textContent = 'A paragraph that genuinely arrived after the run.';
    document.body.appendChild(fresh);
    await settle();
    expect(visibilityChecks).toBeGreaterThan(afterRun);
  });

  it('ignores a page loading a stylesheet, which is not new text', async () => {
    // The observer sits on documentElement so a body swap cannot orphan it,
    // which puts <head> in its subtree. Busy sites rewrite head constantly and
    // none of it is worth re-collecting the page for.
    const seen: string[] = [];
    await translatePage(document, deps({ translate: spy(seen) }));
    expect(seen).toHaveLength(3);

    document.head.appendChild(document.createElement('link'));
    document.head.appendChild(document.createElement('script'));
    await settle();

    expect(seen).toHaveLength(3);
  });

  it('lets go of blocks the page threw away', async () => {
    // Held in a plain Set, because the IntersectionObserver has to be handed
    // the same node to unobserve it. On a feed that trims what scrolled past,
    // this is the one place detached nodes would pile up for the life of the
    // tab.
    document.body.innerHTML = `
      <p id="near">A paragraph the reader can see right now.</p>
      <p id="far">A paragraph a long way down the page.</p>
    `;
    const far = document.getElementById('far');
    if (far) place(far, 5000);
    await translatePage(document, deps());
    expect(far && observer().observed.has(far)).toBe(true);

    far?.remove();
    // Any mutation at all schedules the rescan that does the sweeping.
    document.body.appendChild(document.createElement('hr'));
    await settle();

    expect(far && observer().observed.has(far)).toBe(false);
  });

  it('skips a block that left the page before its turn came', async () => {
    // An SPA route change, or a feed trimming what scrolled past. Translating
    // it would attach text to a node nobody will ever see, and counting it as a
    // failure would march ⚠️ down a page that is doing nothing wrong.
    const seen: string[] = [];
    let release: (() => void) | null = null;
    const run = translatePage(
      document,
      deps({
        translate: (text) => {
          seen.push(text);
          if (seen.length > 1) return Promise.resolve(`[zh] ${text}`);
          // Hold the ramp-up block open, so the rest of the queue is still
          // waiting when the page changes under it.
          return new Promise<string>((resolve) => {
            release = () => {
              resolve(`[zh] ${text}`);
            };
          });
        },
      }),
    );
    await Promise.resolve();
    document.getElementById('b')?.remove();
    (release as (() => void) | null)?.();
    const result = await run;

    expect(seen).not.toContain('The second paragraph of the article body.');
    expect(result.failed).toBe(0);
    expect(result.translated).toBe(2);
  });
});

describe('how the translation looks', () => {
  const originals = (): string[] =>
    Array.from(document.querySelectorAll(`.${ORIGINAL_CLASS}`)).map(
      (node) => node.textContent ?? '',
    );

  it('leaves the page alone in bilingual mode', async () => {
    // The default, and the reason this project exists: a local model is good,
    // not perfect, and a suspicious sentence has to be checkable. Wrapping the
    // original would move nodes on a live page for no reason.
    await translatePage(document, deps());
    expect(originals()).toEqual([]);
    expect(document.getElementById('a')?.firstChild?.textContent).toBe(
      'The first paragraph of the article body.',
    );
  });

  it('puts the original somewhere hideable in translation-only mode', async () => {
    // A block's own text nodes cannot be hidden without hiding its children
    // too, so they go into a wrapper that CSS can act on. The text is still
    // there — which is what makes switching back a matter of one attribute.
    await translatePage(
      document,
      deps({
        appearance: {
          displayMode: 'translationOnly',
          translationStyle: 'line',
          translationScale: 'same',
        },
      } as Partial<PageTranslateDeps>),
    );

    expect(originals()).toContain('The first paragraph of the article body.');
    expect(document.documentElement.getAttribute('data-oit-display')).toBe(
      'translationOnly',
    );
    // The translation is still a sibling, not inside the wrapper.
    expect(
      document.querySelector(`#a > .${BILINGUAL_CLASS}`)?.textContent,
    ).toBe('[zh] The first paragraph of the article body.');
  });

  it('restores the page byte for byte when it is cleared', async () => {
    // Undo has to undo the wrapper too, or a page that was translated once
    // keeps a span nobody asked for for the rest of its life.
    const before = document.body.innerHTML;
    await translatePage(
      document,
      deps({
        appearance: {
          displayMode: 'translationOnly',
          translationStyle: 'line',
          translationScale: 'same',
        },
      } as Partial<PageTranslateDeps>),
    );
    expect(originals().length).toBeGreaterThan(0);

    clearPageTranslation(document);
    // The badge takes itself off a couple of seconds later, and removing it is
    // the toggle's job rather than this one's.
    document.getElementById(PROGRESS_ID)?.remove();

    expect(document.querySelectorAll(`.${ORIGINAL_CLASS}`)).toHaveLength(0);
    expect(document.body.innerHTML).toBe(before);
  });

  it('switches an already-translated page without translating again', async () => {
    // Style and size are pure CSS. The display mode is not, and a reader trying
    // the settings while looking at a translated page is exactly when it
    // matters that nothing has to run again.
    const seen: string[] = [];
    await translatePage(
      document,
      deps({
        translate: (text) => {
          seen.push(text);
          return Promise.resolve(`[zh] ${text}`);
        },
      }),
    );
    expect(seen).toHaveLength(3);
    expect(originals()).toEqual([]);

    reflowTranslations(document, 'translationOnly');
    expect(originals().length).toBe(3);

    reflowTranslations(document, 'bilingual');
    expect(originals()).toEqual([]);
    expect(seen).toHaveLength(3);
    expect(translations()).toHaveLength(3);
  });

  it('records the appearance where CSS can act on it', () => {
    applyAppearance(document, {
      displayMode: 'bilingual',
      translationStyle: 'highlight',
      translationScale: 'large',
    });
    const root = document.documentElement;
    expect(root.getAttribute('data-oit-style')).toBe('highlight');
    expect(root.getAttribute('data-oit-scale')).toBe('large');
  });
});
