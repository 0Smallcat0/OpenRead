import { describe, it, expect } from 'vitest';
import { hasPreamble, hasSimplifiedLeak, hasEcho } from './detectors';

describe('hasPreamble', () => {
  it('flags a preamble opening', () => {
    expect(hasPreamble('Sure, here is the translation: 你好')).toBe(true);
  });
  it('passes a clean translation', () => {
    expect(hasPreamble('你好世界')).toBe(false);
  });
});

describe('hasSimplifiedLeak', () => {
  it('flags Simplified-only characters', () => {
    expect(hasSimplifiedLeak('网络连接不稳定')).toBe(true);
  });
  it('passes fully Traditional text', () => {
    expect(hasSimplifiedLeak('網路連線不穩定')).toBe(false);
  });
});

describe('hasEcho', () => {
  it('flags an echoed source prefix', () => {
    expect(hasEcho('Hello world', 'Hello world 你好世界')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(hasEcho('Hello', 'hello 你好')).toBe(true);
  });
  it('passes when the source is not echoed', () => {
    expect(hasEcho('Hello world', '你好世界')).toBe(false);
  });
});
