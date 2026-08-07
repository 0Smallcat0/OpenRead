// @vitest-environment jsdom
/**
 * Settings are one `chrome.storage.sync` item, and that API rejects any single
 * item over 8,192 bytes — as a whole, not per key. The one field a user can
 * grow without limit is therefore the one that can take every other setting
 * down with it.
 */
import { describe, it, expect } from 'vitest';
import {
  limitExcept,
  limitGlossary,
  MAX_EXCEPT_BYTES,
  MAX_GLOSSARY_BYTES,
} from './settings';

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
