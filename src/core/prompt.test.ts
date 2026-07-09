import { describe, it, expect } from 'vitest';
import { generateSystemPrompt, getFewShotMessages } from './prompt';

describe('generateSystemPrompt', () => {
  it('produces an English-target prompt', () => {
    const p = generateSystemPrompt('English');
    expect(p).toContain('Target: English.');
    expect(p).toContain('Output ONLY the translation.');
  });

  it('produces a Taiwan-specialised prompt for Traditional Chinese', () => {
    const p = generateSystemPrompt('Traditional Chinese');
    expect(p).toContain('Traditional Chinese (Taiwan)');
    expect(p).toContain('Taiwan IT/finance terms');
  });

  it('falls back to a generic prompt naming the target language', () => {
    const p = generateSystemPrompt('French');
    expect(p).toContain('Target: French.');
    expect(p).toContain('Translate DIRECTLY.');
  });
});

describe('getFewShotMessages', () => {
  it('returns anti-echo examples for a Chinese target', () => {
    const shots = getFewShotMessages('Traditional Chinese');
    expect(shots).toHaveLength(4);
    // Last assistant message must differ from its user input (no-echo priming).
    expect(shots[3]?.content).not.toBe(shots[2]?.content);
  });

  it('uses Traditional glyphs for a Traditional target', () => {
    const shots = getFewShotMessages('Traditional Chinese');
    expect(shots[1]?.content).toBe('法國的首都是哪裡？');
  });

  it('uses Simplified glyphs for a Simplified target', () => {
    const shots = getFewShotMessages('Simplified Chinese');
    expect(shots[1]?.content).toBe('法国的首都是哪里？');
  });

  it('returns no examples for non-Chinese targets (latency)', () => {
    expect(getFewShotMessages('English')).toEqual([]);
    expect(getFewShotMessages('French')).toEqual([]);
  });
});
