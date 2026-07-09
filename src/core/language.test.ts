import { describe, it, expect } from 'vitest';
import { detectChineseScript, detectScripts, shouldBypassAI } from './language';

describe('detectChineseScript', () => {
  it('detects Simplified from a distinct marker', () => {
    expect(detectChineseScript('这是简体中文测试')).toBe('sc');
  });

  it('detects Traditional from a distinct marker', () => {
    expect(detectChineseScript('這是繁體中文測試')).toBe('tc');
  });

  it('returns unknown for script-neutral characters', () => {
    // None of 我/的/山/水 are distinct to either script.
    expect(detectChineseScript('我的山水')).toBe('unknown');
  });
});

describe('detectScripts', () => {
  it('flags Latin-only text', () => {
    expect(detectScripts('Hello world')).toMatchObject({
      hasChinese: false,
      isLatin: true,
    });
  });

  it('flags Japanese kana', () => {
    expect(detectScripts('これはテスト')).toMatchObject({ hasJapanese: true });
  });

  it('flags Korean hangul', () => {
    expect(detectScripts('안녕하세요')).toMatchObject({ hasKorean: true });
  });
});

describe('shouldBypassAI', () => {
  it('bypasses Traditional source when target is Traditional', () => {
    expect(shouldBypassAI('這是測試', 'Traditional Chinese')).toBe(true);
  });

  it('does NOT bypass Simplified source when target is Traditional (needs conversion)', () => {
    expect(shouldBypassAI('这是简体', 'Traditional Chinese')).toBe(false);
  });

  it('does NOT bypass English source when target is Traditional', () => {
    expect(shouldBypassAI('Hello world', 'Traditional Chinese')).toBe(false);
  });

  it('bypasses Japanese source when target is Japanese', () => {
    expect(shouldBypassAI('これはテスト', 'Japanese')).toBe(true);
  });

  it('bypasses Korean source when target is Korean', () => {
    expect(shouldBypassAI('안녕하세요', 'Korean')).toBe(true);
  });

  it('returns false on empty input', () => {
    expect(shouldBypassAI('', 'Traditional Chinese')).toBe(false);
  });
});
