import { describe, it, expect } from 'vitest';
import { toTraditionalTW } from './zh-convert';

describe('toTraditionalTW', () => {
  it('converts a Simplified sentence to Traditional', () => {
    expect(toTraditionalTW('这是简体中文')).toBe('這是簡體中文');
  });

  it('maps mainland tech vocabulary to Taiwan usage (phrase-level)', () => {
    expect(toTraditionalTW('鼠标')).toBe('滑鼠');
    expect(toTraditionalTW('软件')).toBe('軟體');
  });

  // Regression guards for v1's zh-map.js corruption.
  it('does NOT corrupt 界面 into 界麵 (fixes v1 bug)', () => {
    expect(toTraditionalTW('界面')).toBe('介面');
  });

  it('does NOT corrupt 公里 into 公裡 (fixes v1 bug)', () => {
    expect(toTraditionalTW('公里')).toBe('公里');
  });

  it('leaves already-Traditional text intact', () => {
    expect(toTraditionalTW('這是繁體中文')).toBe('這是繁體中文');
  });

  it('returns empty input unchanged', () => {
    expect(toTraditionalTW('')).toBe('');
  });
});
