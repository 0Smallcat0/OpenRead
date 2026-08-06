import { describe, it, expect } from 'vitest';
import { toBcp47, isBuiltinTarget } from './bcp47';
import { TARGET_LANGUAGES } from '../settings';

describe('toBcp47', () => {
  it('distinguishes Traditional from Simplified, which is the whole point', () => {
    // `zh` would hand a Taiwanese reader the Simplified-flavoured output this
    // project exists to avoid.
    expect(toBcp47('Traditional Chinese')).toBe('zh-Hant');
    expect(toBcp47('Simplified Chinese')).toBe('zh');
  });

  it('covers every language the popup offers', () => {
    for (const language of TARGET_LANGUAGES) {
      expect(toBcp47(language), language).not.toBeNull();
    }
  });

  it('ignores surrounding whitespace', () => {
    expect(toBcp47('  Japanese ')).toBe('ja');
  });

  it('passes through a value that is already a code', () => {
    expect(toBcp47('pt-BR')).toBe('pt-BR');
    expect(toBcp47('nl')).toBe('nl');
  });

  it('returns null for something it has no code for', () => {
    // Null is an answer, not a failure to handle: that language has to take
    // the Ollama path, and guessing `en` would translate into the wrong
    // language rather than declining to.
    expect(toBcp47('Klingon')).toBeNull();
    expect(toBcp47('')).toBeNull();
    expect(toBcp47('   ')).toBeNull();
  });
});

describe('isBuiltinTarget', () => {
  it('agrees with toBcp47', () => {
    expect(isBuiltinTarget('Traditional Chinese')).toBe(true);
    expect(isBuiltinTarget('Klingon')).toBe(false);
  });
});

describe('the popup list and the code table', () => {
  it('maps every language the popup offers', async () => {
    // Two lists, one meaning. They lived in different files and there was
    // nothing stopping one from growing without the other, which would put a
    // language in the dropdown that `toBcp47` answers null for — and null
    // means "the built-in engine cannot serve this", so the entry would
    // silently fall through to an Ollama the user may not have.
    const { TARGET_LANGUAGES } = await import('../settings');
    for (const name of TARGET_LANGUAGES) {
      expect(toBcp47(name), `${name} has no BCP-47 code`).not.toBeNull();
    }
  });
});
