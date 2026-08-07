import { describe, it, expect } from 'vitest';
import { normaliseCue, isTranslatableCue, CueCache } from './cues';

describe('normaliseCue', () => {
  it('collapses the whitespace a split caption arrives with', () => {
    // A player renders one caption as several spans and rebuilds them
    // constantly; without this the same line is two different cues.
    expect(normaliseCue('Hello   there')).toBe('Hello there');
    expect(normaliseCue('  Hello\n  there  ')).toBe('Hello there');
  });

  it('leaves an ordinary line alone', () => {
    expect(normaliseCue('And then it worked.')).toBe('And then it worked.');
  });
});

describe('isTranslatableCue', () => {
  it('takes a line of speech', () => {
    expect(isTranslatableCue('And then it worked.')).toBe(true);
  });

  it('refuses a sound marker', () => {
    expect(isTranslatableCue('[Music]')).toBe(false);
    expect(isTranslatableCue('(applause)')).toBe(false);
    expect(isTranslatableCue('  [ APPLAUSE ]  ')).toBe(false);
  });

  it('refuses musical notation', () => {
    expect(isTranslatableCue('♪♪')).toBe(false);
    expect(isTranslatableCue('♪ ♫ ♪')).toBe(false);
  });

  it('refuses a line with no letters in it', () => {
    expect(isTranslatableCue('12:04')).toBe(false);
    expect(isTranslatableCue('--')).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isTranslatableCue('')).toBe(false);
    expect(isTranslatableCue('   ')).toBe(false);
  });

  it('takes a line that merely mentions music', () => {
    // The rule is about a cue that *is* a marker, not one containing a bracket.
    expect(isTranslatableCue('The [Music] label signed them in 1974.')).toBe(
      true,
    );
  });

  it('takes CJK, which has no Latin letters in it', () => {
    expect(isTranslatableCue('這是一句字幕')).toBe(true);
  });
});

describe('CueCache', () => {
  it('answers with what it was given', () => {
    const cache = new CueCache();
    cache.set('Hello there', '你好');
    expect(cache.get('Hello there')).toBe('你好');
  });

  it('matches through the whitespace a repaint changed', () => {
    const cache = new CueCache();
    cache.set('Hello there', '你好');
    expect(cache.get('  Hello   there ')).toBe('你好');
  });

  it('says nothing for a line it has not seen', () => {
    expect(new CueCache().get('Hello there')).toBeUndefined();
  });

  it('stays bounded, dropping the least recently used', () => {
    const cache = new CueCache(3);
    cache.set('a a', '1');
    cache.set('b b', '2');
    cache.set('c c', '3');
    // Touching `a a` makes `b b` the oldest.
    expect(cache.get('a a')).toBe('1');
    cache.set('d d', '4');

    expect(cache.size).toBe(3);
    expect(cache.get('b b')).toBeUndefined();
    expect(cache.get('a a')).toBe('1');
    expect(cache.get('d d')).toBe('4');
  });

  it('overwrites rather than growing on a repeat', () => {
    const cache = new CueCache();
    cache.set('a a', '1');
    cache.set('a a', '2');
    expect(cache.size).toBe(1);
    expect(cache.get('a a')).toBe('2');
  });

  it('empties on demand, for a video that was navigated away from', () => {
    const cache = new CueCache();
    cache.set('a a', '1');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
