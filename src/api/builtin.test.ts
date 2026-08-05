/**
 * The built-in engine, driven against a stubbed `Translator`.
 *
 * What matters here is not that Chrome can translate — it can, and that is
 * measured by `pnpm e2e:page` against the real API. What matters is which
 * requests this module refuses and how, because every refusal is a fallback to
 * Ollama and every silent wrong answer is a page full of confident nonsense.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  translateBuiltin,
  detectLanguage,
  isBuiltinSupported,
  BuiltinUnavailableError,
} from './builtin';

interface Stub {
  availability?: string;
  streaming?: boolean;
  detected?: { detectedLanguage: string; confidence: number }[] | null;
  noDetector?: boolean;
  noTranslator?: boolean;
}

let created: { sourceLanguage: string; targetLanguage: string }[];
let translated: string[];

function stub({
  availability = 'available',
  streaming = false,
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
              return Promise.resolve(`[zh] ${input}`);
            },
            translateStreaming: streaming
              ? (input: string) => {
                  translated.push(input);
                  return new ReadableStream<string>({
                    start(controller) {
                      controller.enqueue('[zh] ');
                      controller.enqueue(input);
                      controller.close();
                    },
                  });
                }
              : undefined,
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

  it('streams when Chrome offers streaming', async () => {
    stub({ streaming: true });
    expect(
      await collect({ text: 'Hello', targetLang: 'Traditional Chinese' }),
    ).toBe('[zh] Hello');
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
