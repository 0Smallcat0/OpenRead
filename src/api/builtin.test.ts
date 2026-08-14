/**
 * The built-in engine, driven against a stubbed `Translator`.
 *
 * What matters here is not that Chrome can translate — it can, and that is
 * measured by `pnpm e2e:page` against the real API. What matters is which
 * requests this module refuses and how, because every refusal is a fallback to
 * Ollama and every silent wrong answer is a page full of confident nonsense.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  translateBuiltin,
  detectLanguage,
  isBuiltinSupported,
  resetTranslatorCache,
  BuiltinUnavailableError,
  DOWNLOAD_STALL_MS,
} from './builtin';

interface Stub {
  availability?: string;
  translation?: string;
  detected?: { detectedLanguage: string; confidence: number }[] | null;
  noDetector?: boolean;
  noTranslator?: boolean;
}

let created: { sourceLanguage: string; targetLanguage: string }[];
let translated: string[];

function stub({
  availability = 'available',
  translation,
  detected = [{ detectedLanguage: 'en', confidence: 0.9 }],
  noDetector = false,
  noTranslator = false,
}: Stub = {}): void {
  const global = globalThis as unknown as Record<string, unknown>;

  global.Translator = noTranslator
    ? undefined
    : {
        availability: () => Promise.resolve(availability),
        create: (options: {
          sourceLanguage: string;
          targetLanguage: string;
        }) => {
          created.push({
            sourceLanguage: options.sourceLanguage,
            targetLanguage: options.targetLanguage,
          });
          return Promise.resolve({
            translate: (input: string) => {
              translated.push(input);
              return Promise.resolve(translation ?? `[zh] ${input}`);
            },
            destroy: () => undefined,
          });
        },
      };

  global.LanguageDetector =
    noDetector || detected === null
      ? undefined
      : {
          availability: () => Promise.resolve('available'),
          create: () =>
            Promise.resolve({
              detect: () => Promise.resolve(detected),
              destroy: () => undefined,
            }),
        };
}

async function collect(params: {
  text: string;
  targetLang: string;
  sourceLang?: string;
}): Promise<string> {
  let out = '';
  await translateBuiltin({ ...params, onChunk: (chunk) => (out += chunk) });
  return out;
}

beforeEach(() => {
  created = [];
  translated = [];
  // Translators are cached per language pair for the life of the worker, which
  // is the point of them; each test needs its own worker.
  resetTranslatorCache();
});

afterEach(() => {
  const global = globalThis as unknown as Record<string, unknown>;
  delete global.Translator;
  delete global.LanguageDetector;
});

describe('isBuiltinSupported', () => {
  it('is false on a browser without the API', () => {
    stub({ noTranslator: true });
    expect(isBuiltinSupported()).toBe(false);
  });

  it('is true when Chrome exposes it', () => {
    stub();
    expect(isBuiltinSupported()).toBe(true);
  });
});

describe('translateBuiltin', () => {
  it('translates, and asks for the code the target maps to', async () => {
    stub();
    expect(
      await collect({ text: 'Hello', targetLang: 'Traditional Chinese' }),
    ).toBe('[zh] Hello');
    expect(created[0]).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hant',
    });
  });

  it('rewrites mainland vocabulary into Taiwan usage', async () => {
    // Chrome's zh-Hant is Traditional characters with mainland word choices:
    // one real article produced 12 x 本地, 10 x 運行, 3 x 用戶.
    stub({ translation: '允許用戶在本地機器上運行模型' });
    expect(
      await collect({ text: 'x', targetLang: 'Traditional Chinese' }),
    ).toBe('允許使用者在本機上執行模型');
  });

  it('leaves Simplified targets to OpenCC', async () => {
    stub({ translation: '允許用戶運行' });
    expect(await collect({ text: 'x', targetLang: 'Simplified Chinese' })).toBe(
      '允許用戶運行',
    );
  });

  it('trusts the page over the detector', async () => {
    // The failure this fixes: six blocks of one Wikipedia article detected
    // under 0.5 confidence — "Ollama running Llama 3 in Linux" at 0.248 —
    // while the page had declared `lang="en"` all along.
    stub({ detected: [{ detectedLanguage: 'de', confidence: 0.3 }] });
    await collect({
      text: 'Ollama running Llama 3 in Linux',
      targetLang: 'Traditional Chinese',
      sourceLang: 'en',
    });
    expect(created[0]?.sourceLanguage).toBe('en');
  });

  it('tidies a sloppy lang attribute rather than passing it through', async () => {
    stub();
    await collect({
      text: 'Hello',
      targetLang: 'Traditional Chinese',
      sourceLang: 'EN_us',
    });
    expect(created[0]?.sourceLanguage).toBe('en-us');
  });

  it('falls back to detection when the page declares nothing usable', async () => {
    stub();
    await collect({
      text: 'Hello',
      targetLang: 'Traditional Chinese',
      sourceLang: '   ',
    });
    expect(created[0]?.sourceLanguage).toBe('en');
  });

  it('returns the text unchanged when it is already the target language', async () => {
    // Chrome has no zh-Hant -> zh-Hant pack, so asking would be an error.
    // Passing the text through is the honest answer to "translate this into
    // the language it is already in".
    stub();
    const out = await collect({
      text: '這段已經是繁體中文。',
      targetLang: 'Traditional Chinese',
      sourceLang: 'zh-TW',
    });
    expect(out).toBe('這段已經是繁體中文。');
    expect(created).toEqual([]);
  });

  it('declines a language it has no code for, so Ollama can take it', async () => {
    stub();
    await expect(
      collect({ text: 'Hello', targetLang: 'Klingon' }),
    ).rejects.toBeInstanceOf(BuiltinUnavailableError);
  });

  it('declines when Chrome has no language pack', async () => {
    stub({ availability: 'unavailable' });
    await expect(
      collect({ text: 'Hello', targetLang: 'Traditional Chinese' }),
    ).rejects.toBeInstanceOf(BuiltinUnavailableError);
  });

  it('declines on a browser without the API at all', async () => {
    stub({ noTranslator: true });
    await expect(
      collect({ text: 'Hello', targetLang: 'Traditional Chinese' }),
    ).rejects.toBeInstanceOf(BuiltinUnavailableError);
  });

  it('declines when nothing can name the source language', async () => {
    stub({ noDetector: true });
    await expect(
      collect({ text: 'Hello', targetLang: 'Traditional Chinese' }),
    ).rejects.toBeInstanceOf(BuiltinUnavailableError);
  });

  it('does nothing at all for blank input', async () => {
    stub();
    expect(
      await collect({ text: '   ', targetLang: 'Traditional Chinese' }),
    ).toBe('');
    expect(created).toEqual([]);
  });
});

describe('detectLanguage', () => {
  it('accepts a low-confidence guess, because a caption is short', async () => {
    // 0.248 was a real reading on plain English. Refusing it cost six blocks.
    stub({ detected: [{ detectedLanguage: 'en', confidence: 0.248 }] });
    expect(await detectLanguage('Ollama running Llama 3 in Linux')).toBe('en');
  });

  it('discards a guess that is barely a guess', async () => {
    stub({ detected: [{ detectedLanguage: 'ar-Latn', confidence: 0.05 }] });
    expect(await detectLanguage('x')).toBeNull();
  });

  it('is null when the detector is missing or empty-handed', async () => {
    stub({ noDetector: true });
    expect(await detectLanguage('Hello')).toBeNull();
    stub({ detected: [] });
    expect(await detectLanguage('Hello')).toBeNull();
  });
});

describe('reusing the translator for a language pair', () => {
  it('creates one translator for many blocks', async () => {
    // The reported failure: switching to a language whose pack is not
    // installed left whole-page translation crawling. Every block called
    // `Translator.create()`, and while the pack is still downloading each of
    // those waits on its own — measured at 145,687 ms for one create against
    // 77 ms for the translation itself, with the badge advancing two blocks
    // every thirty seconds.
    stub();
    for (let i = 0; i < 8; i++) {
      await collect({
        text: `Block number ${String(i)} of the article.`,
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      });
    }

    expect(translated).toHaveLength(8);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'zh-Hant',
    });
  });

  it('creates a second translator when the target language changes', async () => {
    stub();
    await collect({
      text: 'The first paragraph.',
      targetLang: 'Traditional Chinese',
      sourceLang: 'en',
    });
    await collect({
      text: 'The first paragraph.',
      targetLang: 'Japanese',
      sourceLang: 'en',
    });
    await collect({
      text: 'The second paragraph.',
      targetLang: 'Japanese',
      sourceLang: 'en',
    });

    expect(created).toEqual([
      { sourceLanguage: 'en', targetLanguage: 'zh-Hant' },
      { sourceLanguage: 'en', targetLanguage: 'ja' },
    ]);
  });

  it('does not remember a create that failed', async () => {
    // One bad moment must not poison the pair for the life of the worker.
    const global = globalThis as unknown as Record<string, unknown>;
    let attempts = 0;
    global.Translator = {
      availability: () => Promise.resolve('available'),
      create: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error('download interrupted'))
          : Promise.resolve({
              translate: (input: string) => Promise.resolve(`[zh] ${input}`),
            });
      },
    };

    await expect(
      collect({
        text: 'The first attempt.',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      }),
    ).rejects.toThrow('download interrupted');

    expect(
      await collect({
        text: 'The second attempt.',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      }),
    ).toBe('[zh] The second attempt.');
    expect(attempts).toBe(2);
  });

  it('gives up immediately when aborted during a download', async () => {
    // Stop has to be instant even though the create it is waiting on is shared
    // and deliberately left running for whoever asks next.
    const global = globalThis as unknown as Record<string, unknown>;
    let settled = false;
    global.Translator = {
      availability: () => Promise.resolve('downloadable'),
      create: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve({ translate: (input: string) => Promise.resolve(input) });
          }, 50);
        }),
    };

    const controller = new AbortController();
    const run = translateBuiltin({
      text: 'A paragraph waiting on a language pack.',
      targetLang: 'Traditional Chinese',
      sourceLang: 'en',
      signal: controller.signal,
      onChunk: () => undefined,
    });
    controller.abort();

    await expect(run).rejects.toThrow(/abort/i);
    expect(settled).toBe(false);
  });
});

describe('a translator instance that is dead on arrival', () => {
  /**
   * `Translator.create()` can resolve with an instance whose language pack is
   * not installed yet. Measured in a real Chrome against a cold profile: nine
   * pairs created at once, all nine creates resolved, seven of the nine then
   * threw `UnknownError: Other generic failures occurred.` on their first
   * `translate()` and never worked again. `availability` said `available`
   * straight afterwards and a freshly created translator for the same pair
   * worked on the spot — so the pack was fine and only the handle was not.
   *
   * Since 2.8.1 that handle is cached for the life of the worker, so one bad
   * create used to mean every later request for the pair got Chrome's generic
   * message with no way back short of restarting the browser. That is what
   * reached a user mid-session.
   */
  function stubWithDeadFirstInstance(deadCount: number): () => number {
    const global = globalThis as unknown as Record<string, unknown>;
    let creates = 0;
    global.Translator = {
      availability: () => Promise.resolve('available'),
      create: () => {
        const mine = ++creates;
        return Promise.resolve({
          translate: (input: string) =>
            mine <= deadCount
              ? Promise.reject(
                  Object.assign(new Error('Other generic failures occurred.'), {
                    name: 'UnknownError',
                  }),
                )
              : Promise.resolve(`[zh] ${input}`),
        });
      },
    };
    return () => creates;
  }

  it('throws it away and succeeds on a fresh one', async () => {
    const creates = stubWithDeadFirstInstance(1);
    expect(
      await collect({
        text: 'Hello',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      }),
    ).toBe('[zh] Hello');
    expect(creates()).toBe(2);
  });

  it('does not leave the dead one in the cache for the next request', async () => {
    // The bug was not the first failure, it was every failure after it.
    const creates = stubWithDeadFirstInstance(1);
    const params = {
      text: 'Hello',
      targetLang: 'Traditional Chinese',
      sourceLang: 'en',
    };
    await collect(params);
    expect(await collect(params)).toBe('[zh] Hello');
    // Two creates for the first call, and the second call reuses the survivor.
    expect(creates()).toBe(2);
  });

  it('says something a reader can act on when the retry fails too', async () => {
    // Chrome's own wording — "Other generic failures occurred." — was going
    // straight into the panel, which tells the reader nothing to do.
    stubWithDeadFirstInstance(2);
    await expect(
      collect({
        text: 'Hello',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      }),
    ).rejects.toThrow(/Try again in a moment/);
  });

  it('does not fall back to Ollama on it', async () => {
    // A `BuiltinUnavailableError` means "this engine cannot do it, try the
    // other one", and answering a built-in-engine user with "Can't reach
    // Ollama" would be true and about the wrong thing.
    stubWithDeadFirstInstance(2);
    await expect(
      collect({
        text: 'Hello',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      }),
    ).rejects.not.toBeInstanceOf(BuiltinUnavailableError);
  });

  it('leaves an abort alone rather than retrying it', async () => {
    const global = globalThis as unknown as Record<string, unknown>;
    let creates = 0;
    global.Translator = {
      availability: () => Promise.resolve('available'),
      create: () => {
        creates++;
        return Promise.resolve({
          translate: () =>
            Promise.reject(new DOMException('Aborted', 'AbortError')),
        });
      },
    };
    await expect(
      collect({
        text: 'Hello',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
      }),
    ).rejects.toThrow(/abort/i);
    expect(creates).toBe(1);
  });
});

describe('zh is two scripts wearing one code', () => {
  it('converts a Simplified page asked for Traditional Chinese', async () => {
    // `zh-CN` and `zh-Hant` both reduce to `zh`, so the same-language
    // short-circuit used to hand a Taiwanese reader the Simplified text back
    // and report the page as needing no translation. Chrome has no
    // zh-Hans -> zh-Hant pack; OpenCC does this conversion for the Ollama path
    // already.
    stub();
    const out = await collect({
      text: '这个软件开发工具的用户界面',
      targetLang: 'Traditional Chinese',
      sourceLang: 'zh-CN',
    });
    expect(out).toContain('軟體');
    expect(out).not.toContain('软件');
    // Nothing was asked of Chrome — the conversion is local.
    expect(created).toHaveLength(0);
  });

  it('leaves a Traditional page alone apart from the vocabulary pass', async () => {
    stub();
    const out = await collect({
      text: '這個軟體開發工具',
      targetLang: 'Traditional Chinese',
      sourceLang: 'zh-TW',
    });
    expect(out).toBe('這個軟體開發工具');
    expect(created).toHaveLength(0);
  });

  it('still hands an English page back verbatim when asked for English', async () => {
    stub();
    const out = await collect({
      text: 'A purely peer-to-peer version of electronic cash.',
      targetLang: 'English',
      sourceLang: 'en',
    });
    expect(out).toBe('A purely peer-to-peer version of electronic cash.');
    expect(created).toHaveLength(0);
  });
});

describe('a language-pack download that never moves', () => {
  it('stops waiting and says what to check', async () => {
    // Reported from a fresh install on a fresh Chrome: the badge read
    // "Downloading language pack…" and stayed there. There was no timeout
    // anywhere on this path and `Translator.create()` has none of its own, so
    // a download the component updater never starts — no disk space, a
    // metered connection, a network that blocks it — left the reader watching
    // a spinner for as long as the tab was open.
    const global = globalThis as unknown as Record<string, unknown>;
    global.Translator = {
      availability: () => Promise.resolve('downloadable'),
      // Never settles, which is the whole failure.
      create: () => new Promise(() => undefined),
    };

    vi.useFakeTimers();
    try {
      const run = translateBuiltin({
        text: 'A paragraph waiting on a language pack that is not coming.',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
        onChunk: () => undefined,
      });
      const settled = Promise.all([
        expect(run).rejects.toThrow(BuiltinUnavailableError),
        // The class alone would also match "Chrome has no en → zh-Hant
        // language pack", which is a different problem with a different fix.
        expect(run).rejects.toThrow(/22 GB|metered|on-device-internals/),
      ]);
      // The availability check is a promise of its own, so the watchdog is not
      // armed until the microtask queue has drained.
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS + 1000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits as long as the download keeps moving', async () => {
    // The measured worst case is 81 seconds with exactly two progress events,
    // so a total timeout would cancel real downloads. This one measures
    // silence: every event resets it.
    const global = globalThis as unknown as Record<string, unknown>;
    // A holder rather than a bare `let`: TypeScript cannot see the assignment
    // that happens inside the monitor callback and narrows the variable to
    // `null` at the call site below.
    const bus: { report: ((loaded: number) => void) | null } = { report: null };
    global.Translator = {
      availability: () => Promise.resolve('downloadable'),
      create: (options: {
        monitor?: (m: {
          addEventListener: (
            type: string,
            listener: (event: { loaded: number }) => void,
          ) => void;
        }) => void;
      }) => {
        options.monitor?.({
          addEventListener: (_type, listener) => {
            bus.report = (loaded) => {
              listener({ loaded });
            };
          },
        });
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ translate: (input: string) => Promise.resolve(input) });
          }, DOWNLOAD_STALL_MS * 3);
        });
      },
    };

    vi.useFakeTimers();
    try {
      const chunks: string[] = [];
      const run = translateBuiltin({
        text: 'A paragraph waiting on a download that is slow but alive.',
        targetLang: 'Traditional Chinese',
        sourceLang: 'en',
        onChunk: (chunk) => chunks.push(chunk),
      });
      // Three quiet stretches, each just short of the deadline, each ended by
      // a progress event. A total timeout would have given up during the first.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1000);
        bus.report?.(0.25 * (i + 1));
      }
      await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS);
      await run;
      expect(chunks.join('')).toContain('slow but alive');
    } finally {
      vi.useRealTimers();
    }
  });
});
