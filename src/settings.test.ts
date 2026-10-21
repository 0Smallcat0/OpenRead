// @vitest-environment jsdom
/**
 * Settings are one `chrome.storage.sync` item, and that API rejects any single
 * item over 8,192 bytes — as a whole, not per key. The one field a user can
 * grow without limit is therefore the one that can take every other setting
 * down with it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  activeModel,
  defaultTargetLang,
  limitExcept,
  limitGlossary,
  loadApiKey,
  loadSettings,
  DEFAULT_SETTINGS,
  MAX_EXCEPT_BYTES,
  MAX_GLOSSARY_BYTES,
} from './settings';

describe('the target language on a first install', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  const browser = (ui: string, stored: Record<string, unknown> = {}): void => {
    (globalThis as { chrome?: unknown }).chrome = {
      i18n: { getUILanguage: () => ui },
      storage: { sync: { get: () => Promise.resolve(stored) } },
    };
  };

  it("is the browser's own language", async () => {
    browser('ja');
    expect((await loadSettings()).targetLang).toBe('Japanese');
    browser('zh-TW');
    expect((await loadSettings()).targetLang).toBe('Traditional Chinese');
  });

  it('never overrides a language the reader chose', async () => {
    browser('ja', { targetLang: 'Korean' });
    expect((await loadSettings()).targetLang).toBe('Korean');
  });

  it('falls back to the shipped default where it cannot tell', () => {
    browser('fa-IR');
    expect(defaultTargetLang()).toBe(DEFAULT_SETTINGS.targetLang);
    delete (globalThis as { chrome?: unknown }).chrome;
    expect(defaultTargetLang()).toBe(DEFAULT_SETTINGS.targetLang);
  });
});

describe('the API key', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('reads as empty where there is no local storage to ask', async () => {
    expect(await loadApiKey()).toBe('');
  });

  it('reads back what was stored, and nothing that is not a string', async () => {
    let value: unknown = 'sk-test';
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: () => Promise.resolve({ apiKey: value }) } },
    };
    expect(await loadApiKey()).toBe('sk-test');
    value = 42;
    expect(await loadApiKey()).toBe('');
  });
});

describe('activeModel', () => {
  it('names the model the chosen engine will actually run', () => {
    const base = { ...DEFAULT_SETTINGS, modelId: 'qwen3', apiModel: 'remote' };
    expect(activeModel({ ...base, engine: 'ollama' })).toBe('qwen3');
    expect(activeModel({ ...base, engine: 'openai' })).toBe('remote');
  });
});

describe('limitExcept', () => {
  it('leaves an ordinary list alone', () => {
    const hosts = ['example.com', 'news.example.org', 'docs.example.net'];
    expect(limitExcept(hosts)).toEqual(hosts);
  });

  it('trims a list that storage would reject outright', () => {
    // Measured against a real Chrome: 200 hosts of ordinary length throws
    // `Resource::kQuotaBytesPerItem quota exceeded`, and the rejection takes
    // the target language and the engine with it.
    const hosts = Array.from(
      { length: 400 },
      (_, i) => `site-${String(i)}-with-a-fairly-long-name.example.com`,
    );
    const kept = limitExcept(hosts);

    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_EXCEPT_BYTES);
    expect(kept.length).toBeLessThan(hosts.length);
    // Newest kept: the site excluded a moment ago is the one being used.
    expect(kept.at(-1)).toBe(hosts.at(-1));
  });

  it('still holds far more hosts than anyone excludes by hand', () => {
    const hosts = Array.from(
      { length: 120 },
      (_, i) => `site-${String(i)}.example.com`,
    );
    expect(limitExcept(hosts)).toEqual(hosts);
  });

  it('cannot loop forever on a single entry that is too big on its own', () => {
    expect(limitExcept(['x'.repeat(MAX_EXCEPT_BYTES * 2)])).toEqual([]);
  });
});

describe('limitGlossary', () => {
  it('leaves an ordinary glossary alone', () => {
    const raw = 'OpenRead\nReact Native\nbug = 瑕疵';
    expect(limitGlossary(raw)).toBe(raw);
  });

  it('trims a pasted terminology file to something storage accepts', () => {
    const raw = Array.from(
      { length: 500 },
      (_, i) => `term-number-${String(i)} = 替換詞彙${String(i)}`,
    ).join('\n');
    const kept = limitGlossary(raw);

    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(MAX_GLOSSARY_BYTES);
    // The top kept, not the bottom: a glossary is written in order, unlike an
    // exception list that grows one site at a time as the user browses.
    expect(kept.startsWith('term-number-0 = ')).toBe(true);
  });

  it('cuts on a line boundary, so no half rule survives', () => {
    const raw = Array.from(
      { length: 500 },
      (_, i) => `term-number-${String(i)} = 替換詞彙${String(i)}`,
    ).join('\n');
    // Half a rule is a rule that fires on the wrong string — `term-number-1`
    // truncated to `term-numb` would rewrite every word starting that way.
    for (const line of limitGlossary(raw).split('\n')) {
      expect(raw.split('\n')).toContain(line);
    }
  });

  it('cannot loop forever on one line that is too big on its own', () => {
    expect(limitGlossary('x'.repeat(MAX_GLOSSARY_BYTES * 2))).toBe('');
  });

  it('still holds hundreds of terms', () => {
    const raw = Array.from({ length: 200 }, (_, i) => `Term${String(i)}`).join(
      '\n',
    );
    expect(limitGlossary(raw)).toBe(raw);
  });
});

describe('the limit is in bytes, which is what storage counts', () => {
  const bytes = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

  it('keeps a Chinese glossary under the per-item ceiling', () => {
    // Chrome measures 8,192 bytes of UTF-8, and a CJK character is three of
    // them. Counted in characters, 359 lines of `termN = 資料庫錯誤` passed as
    // 5,993 and went to storage as 9,591 bytes — and the rejected write took
    // the engine and the target language with it, on every save after.
    const raw = Array.from(
      { length: 360 },
      (_, i) => `term${String(i)} = 資料庫錯誤`,
    ).join('\n');
    const kept = limitGlossary(raw);
    expect(bytes(kept)).toBeLessThanOrEqual(MAX_GLOSSARY_BYTES);
    expect(kept.startsWith('term0 = 資料庫錯誤')).toBe(true);
  });

  it('keeps a list of non-ASCII hosts under it too', () => {
    const hosts = Array.from(
      { length: 300 },
      (_, i) => `例子${String(i)}.中文網.台灣`,
    );
    expect(bytes(limitExcept(hosts))).toBeLessThanOrEqual(MAX_EXCEPT_BYTES);
  });
});
