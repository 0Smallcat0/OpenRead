import { describe, expect, it } from 'vitest';
import { addStats, chrfFromStats, chrfScore, chrfStats, corpusChrf } from './chrf';

/**
 * Expected values cross-validated against Python sacrebleu 2.6.0
 * (`sacrebleu.sentence_chrf(hyp, [ref])`, default chrF2: char order 6, β=2,
 * whitespace removed, no eps smoothing) — identical to 6 decimal places.
 */
const SACREBLEU_CASES: Array<{
  id: string;
  hyp: string;
  ref: string;
  score: number;
}> = [
  { id: 'hand-tiny', hyp: 'ab', ref: 'ac', score: 25.0 },
  {
    id: 'identical-zh',
    hyp: '快取會將經常存取的資料儲存在記憶體中。',
    ref: '快取會將經常存取的資料儲存在記憶體中。',
    score: 100.0,
  },
  {
    id: 'close-zh',
    hyp: '快取把經常存取的資料存放在記憶體中，減少往返資料庫的次數。',
    ref: '快取會將經常存取的資料儲存在記憶體中，減少往返資料庫的次數。',
    score: 71.339874,
  },
  {
    id: 'far-zh',
    hyp: '緩存把常用數據放內存里，少跑幾趟數據庫。',
    ref: '快取會將經常存取的資料儲存在記憶體中，減少往返資料庫的次數。',
    score: 4.761905,
  },
  {
    id: 'english',
    hyp: 'The cat sat on the mat.',
    ref: 'A cat was sitting on the mat.',
    score: 39.784852,
  },
  {
    id: 'short-zh',
    hyp: '你好世界',
    ref: '哈囉世界',
    score: 20.833333,
  },
];

describe('chrfScore', () => {
  for (const c of SACREBLEU_CASES) {
    it(`matches sacrebleu on ${c.id}`, () => {
      expect(chrfScore(c.hyp, c.ref)).toBeCloseTo(c.score, 5);
    });
  }

  it('ignores whitespace differences, like sacrebleu', () => {
    expect(
      chrfScore(
        '新晶片速度快了 3.2 倍，滿載時功耗 15 瓦。',
        '新晶片速度快了3.2倍，滿載時功耗15瓦。',
      ),
    ).toBe(100);
  });

  it('scores an empty hypothesis 0', () => {
    expect(chrfScore('', '你好')).toBe(0);
  });

  it('scores an empty reference 0', () => {
    expect(chrfScore('你好', '')).toBe(0);
  });
});

describe('chrfStats', () => {
  it('produces per-order clipped counts', () => {
    // hyp "ab": unigrams a,b; bigram ab. ref "ac": unigrams a,c; bigram ac.
    const stats = chrfStats('ab', 'ac');
    expect(stats[0]).toEqual({ match: 1, hyp: 2, ref: 2 });
    expect(stats[1]).toEqual({ match: 0, hyp: 1, ref: 1 });
    expect(stats[2]).toEqual({ match: 0, hyp: 0, ref: 0 });
  });

  it('counts by code point, not UTF-16 code unit', () => {
    // Surrogate-pair characters must count as one character each.
    const stats = chrfStats('𝒂𝒃', '𝒂𝒄');
    expect(stats[0]).toEqual({ match: 1, hyp: 2, ref: 2 });
  });
});

describe('corpusChrf', () => {
  it('matches sacrebleu corpus_chrf on the validation set', () => {
    // sacrebleu 2.6.0 corpus_chrf over the seven non-empty cases: 58.391739
    const pairs = [
      ...SACREBLEU_CASES.map((c) => ({ hypothesis: c.hyp, reference: c.ref })),
      {
        hypothesis: '新晶片速度快了 3.2 倍，滿載時功耗 15 瓦。',
        reference: '新晶片速度快了3.2倍，滿載時功耗15瓦。',
      },
    ];
    expect(corpusChrf(pairs)).toBeCloseTo(58.391739, 5);
  });

  it('aggregates stats rather than averaging segment scores', () => {
    const first = { hypothesis: 'ab', reference: 'ac' };
    const second = { hypothesis: '你好世界', reference: '哈囉世界' };
    const summed = addStats(
      chrfStats(first.hypothesis, first.reference),
      chrfStats(second.hypothesis, second.reference),
    );
    expect(corpusChrf([first, second])).toBeCloseTo(chrfFromStats(summed), 10);
  });
});
