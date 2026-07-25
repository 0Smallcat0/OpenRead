import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  toTraditionalTW,
  TraditionalTWTransform,
  MAX_PHRASE_LEN,
} from './zh-convert';

/** Feed `text` through the streaming transform in `size`-character chunks. */
function stream(text: string, size: number): string {
  const transform = new TraditionalTWTransform();
  let out = '';
  for (let i = 0; i < text.length; i += size) {
    out += transform.push(text.slice(i, i + size));
  }
  return out + transform.end();
}

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

describe('TraditionalTWTransform', () => {
  // Converting each streamed chunk on its own is what v2.2 shipped, and it
  // silently mistranslated any phrase a chunk boundary split.
  const PHRASES = [
    '鼠标',
    '软件',
    '数据库',
    '内存',
    '默认值',
    '视频',
    '人工智能',
    '集成电路',
    '网络服务器',
    '这里有一个方便面',
    '计算机程序设计',
    '在端口上监听',
    '不牺牲下游任务准确性',
    '会阻塞主线程',
    '你有千条妙计我有一定之规',
  ];

  it.each(PHRASES)(
    'streams "%s" identically to a single whole-text conversion',
    (phrase) => {
      const expected = toTraditionalTW(phrase);
      for (let size = 1; size <= phrase.length; size++) {
        expect(stream(phrase, size)).toBe(expected);
      }
    },
  );

  it('is unaffected by where a sentence is split', () => {
    const text =
      '这个软件的默认值存在数据库里，视频编码在下游任务中会阻塞主线程。';
    const expected = toTraditionalTW(text);
    for (let cut = 0; cut <= text.length; cut++) {
      const transform = new TraditionalTWTransform();
      const out =
        transform.push(text.slice(0, cut)) +
        transform.push(text.slice(cut)) +
        transform.end();
      expect(out).toBe(expected);
    }
  });

  it('passes non-Chinese text straight through', () => {
    expect(stream('Hello, world! 123', 3)).toBe('Hello, world! 123');
  });

  it('holds nothing back once the stream ends', () => {
    const transform = new TraditionalTWTransform();
    transform.push('数据');
    expect(transform.end()).toBe('資料');
    expect(transform.end()).toBe('');
  });

  it('keeps the held tail bounded on a long unpunctuated run', () => {
    // Text with no boundary character to cut at, so the tail is held purely on
    // the phrase-length bound. Nothing may accumulate without limit: an entry is
    // at most MAX_PHRASE_LEN long, so the tail settles at roughly twice that.
    const text = '数据库连接池的默认配置会影响下游任务准确性'.repeat(8);
    // Every phrase here converts one-to-one, so emitted length counts consumed
    // characters and the difference is exactly what is still held.
    expect(toTraditionalTW(text)).toHaveLength(text.length);

    const transform = new TraditionalTWTransform();
    let emitted = 0;
    for (let i = 0; i < text.length; i++) {
      emitted += transform.push(text.charAt(i)).length;
      expect(i + 1 - emitted).toBeLessThanOrEqual(MAX_PHRASE_LEN * 2);
    }
    expect(emitted + transform.end().length).toBe(text.length);
  });

  it('never splits an astral character', () => {
    const text = '数据𠀾库';
    expect(stream(text, 1)).toBe(toTraditionalTW(text));
  });
});

describe('MAX_PHRASE_LEN', () => {
  it('matches the longest key in the dictionaries cn -> twp consults', () => {
    // A dependency bump could introduce a longer entry, which would silently
    // shrink the safety margin the streaming transform relies on.
    const DICT = 'node_modules/opencc-js/dist/esm-lib/dict';
    const USED = [
      'STCharacters',
      'STPhrases',
      'TWVariants',
      'TWVariantsPhrases',
      'TWPhrases',
    ];
    let longest = 0;
    for (const name of USED) {
      const src = readFileSync(`${DICT}/${name}.js`, 'utf8');
      const table = /export default "([\s\S]*)"/.exec(src)?.[1] ?? '';
      for (const entry of table.split('|')) {
        const key = entry.split(' ')[0] ?? '';
        if (key.length > longest) longest = key.length;
      }
    }
    expect(longest).toBe(MAX_PHRASE_LEN);
  });
});
