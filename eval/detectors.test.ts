import { describe, it, expect } from 'vitest';
import {
  hasPreamble,
  hasSimplifiedLeak,
  hasEcho,
  hasControlTokenLeak,
} from './detectors';

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

describe('hasControlTokenLeak', () => {
  it('flags the real leak seen in use', () => {
    // Ollama's qwen3 template appends ` /no_think` to the last user message,
    // and the model translated it as if it were part of the sentence.
    expect(
      hasControlTokenLeak('Fetch 是基於 Promise 的，且位於 /no_think 路徑下。'),
    ).toBe(true);
  });

  it('flags a bare /think switch and an underscored form', () => {
    expect(hasControlTokenLeak('翻譯完成 /think')).toBe(true);
    expect(hasControlTokenLeak('模式設為 no_think 之後')).toBe(true);
  });

  it('flags ChatML frame and thinking tokens', () => {
    expect(hasControlTokenLeak('你好<|im_end|>')).toBe(true);
    expect(hasControlTokenLeak('<think>先分析</think>你好')).toBe(true);
    expect(hasControlTokenLeak('你好</think>世界')).toBe(true);
  });

  it('passes a clean translation', () => {
    expect(hasControlTokenLeak('網路連線不穩定，請稍後再試。')).toBe(false);
  });

  it('does not trip on the ordinary English word', () => {
    expect(hasControlTokenLeak('I think the network is down.')).toBe(false);
    expect(hasControlTokenLeak('rethink the approach')).toBe(false);
  });

  it('does not trip on an ordinary path segment', () => {
    expect(hasControlTokenLeak('see /docs/thinking for details')).toBe(false);
  });
});
