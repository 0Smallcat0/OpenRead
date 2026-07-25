import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  detectChineseScript,
  detectScripts,
  hasSimplifiedChars,
  shouldBypassAI,
} from './language';
import { toTraditionalTW } from './zh-convert';
import { SC_ONLY_CLASS, TC_ONLY_CLASS } from './zh-markers.generated';
import { deriveMarkers, toCharClass } from '../../scripts/gen-zh-markers';

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

describe('script marker sets', () => {
  it('match what scripts/gen-zh-markers.ts derives from the dictionaries', () => {
    // The committed generated file must not drift from the installed
    // dictionaries — an opencc-js bump would otherwise change script detection
    // silently. Regenerate with `pnpm gen:markers`.
    const { sc, tc } = deriveMarkers();
    expect(toCharClass(sc)).toBe(SC_ONLY_CLASS);
    expect(toCharClass(tc)).toBe(TC_ONLY_CLASS);
  });

  it('share no character between the two scripts', () => {
    const scSet = new Set(deriveMarkers().sc);
    const overlap = deriveMarkers().tc.filter((c) => scSet.has(c));
    expect(overlap).toEqual([]);
  });

  it('flag no character the shipped converter can produce', () => {
    // Simplified merged several Traditional characters into one shared form,
    // and those shared forms are ordinary Traditional characters. A marker the
    // converter can itself emit guarantees false positives.
    const DICT = 'node_modules/opencc-js/dist/esm-lib/dict';
    const emitted = new Set<string>();
    for (const name of [
      'STCharacters',
      'STPhrases',
      'TWVariants',
      'TWVariantsPhrases',
      'TWPhrases',
    ]) {
      const src = readFileSync(`${DICT}/${name}.js`, 'utf8');
      const table = /export default "([\s\S]*)"/.exec(src)?.[1] ?? '';
      for (const entry of table.split('|')) {
        const value = entry.slice(entry.indexOf(' ') + 1);
        for (const variant of value.split(' ')) {
          for (const c of variant) emitted.add(c);
        }
      }
    }
    const offenders = [...emitted].filter((c) => hasSimplifiedChars(c));
    expect(offenders.join('')).toBe('');
  });

  it('does not flag correct Traditional output as leakage', () => {
    // Regression: 系統 and 下游 were scored as Simplified leakage, which is
    // where the eval's "residual 7.4%" came from.
    for (const text of [
      '大多數生產環境系統會在兩者之間取捨',
      '在保持下游任務準確性的同時',
      '臺北捷運系統每日載運量超過兩百萬人次',
      '這是一個簡單的測試',
    ]) {
      expect(hasSimplifiedChars(text)).toBe(false);
    }
  });

  it('still detects genuine Simplified text', () => {
    for (const text of ['这是简体中文', '网络数据库连接', '请选择语言']) {
      expect(hasSimplifiedChars(text)).toBe(true);
    }
  });

  it('detects Simplified text the hand-written list used to miss', () => {
    // 发, 时, 们, 开, 软, 机 were absent from the hand-written markers, so these
    // scored as clean Traditional output.
    for (const text of [
      '计算机软件开发',
      '我们需要更多的时间',
      '开发者工具',
      '头发很长',
    ]) {
      expect(hasSimplifiedChars(text)).toBe(true);
      expect(detectChineseScript(text)).toBe('sc');
    }
  });

  it('accepts everything the converter outputs for the eval fixtures', () => {
    const simplified = '这个软件的默认值存在数据库里，视频编码会阻塞主线程。';
    expect(hasSimplifiedChars(simplified)).toBe(true);
    expect(hasSimplifiedChars(toTraditionalTW(simplified))).toBe(false);
  });
});

describe('shouldBypassAI with merged characters', () => {
  it('bypasses Traditional text containing script-neutral characters', () => {
    // 系 and 游 are valid Traditional; treating them as Simplified sent
    // already-Traditional selections to the model for no reason.
    expect(shouldBypassAI('系統的下游任務', 'Traditional Chinese')).toBe(true);
  });
});
