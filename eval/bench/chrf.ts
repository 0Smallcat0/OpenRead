/**
 * chrF — character n-gram F-score (Popović, WMT 2015), the standard surface
 * metric for machine-translation quality against a reference.
 *
 * Chosen over BLEU/chrF++ deliberately: Chinese has no whitespace word
 * boundaries, so word-n-gram metrics need a segmenter (a dependency and a
 * noise source); chrF operates on characters and is the widely recommended
 * surface metric for zh targets. Parameters match sacrebleu defaults
 * (char order 6, β = 2, whitespace removed) and the implementation is
 * cross-validated against sacrebleu in `chrf.test.ts`.
 *
 * Pure and dependency-free so the benchmark scores are reproducible anywhere.
 */

export const CHAR_ORDER = 6;
const BETA = 2;

export interface ChrfOrderStats {
  match: number;
  hyp: number;
  ref: number;
}

/** Count character n-grams of one order, whitespace removed, by code point. */
function charNgrams(text: string, n: number): Map<string, number> {
  const chars = Array.from(text.replace(/\s+/g, ''));
  const grams = new Map<string, number>();
  for (let i = 0; i + n <= chars.length; i++) {
    const gram = chars.slice(i, i + n).join('');
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Per-order clipped match / hypothesis / reference counts (orders 1..6). */
export function chrfStats(
  hypothesis: string,
  reference: string,
): ChrfOrderStats[] {
  const stats: ChrfOrderStats[] = [];
  for (let n = 1; n <= CHAR_ORDER; n++) {
    const hypGrams = charNgrams(hypothesis, n);
    const refGrams = charNgrams(reference, n);
    let match = 0;
    let hyp = 0;
    for (const [gram, count] of hypGrams) {
      hyp += count;
      match += Math.min(count, refGrams.get(gram) ?? 0);
    }
    let ref = 0;
    for (const count of refGrams.values()) ref += count;
    stats.push({ match, hyp, ref });
  }
  return stats;
}

/** Element-wise sum of per-order stats — for corpus-level aggregation. */
export function addStats(
  a: ChrfOrderStats[],
  b: ChrfOrderStats[],
): ChrfOrderStats[] {
  return a.map((s, i) => ({
    match: s.match + (b[i]?.match ?? 0),
    hyp: s.hyp + (b[i]?.hyp ?? 0),
    ref: s.ref + (b[i]?.ref ?? 0),
  }));
}

/**
 * chrF from aggregated stats, 0..100. Precision and recall are macro-averaged
 * across the "effective" orders (orders where both sides produced n-grams),
 * then combined into a single Fβ — the chrF-paper formulation, numerically
 * identical to sacrebleu's non-smoothed scoring.
 */
export function chrfFromStats(stats: ChrfOrderStats[]): number {
  const betaSq = BETA * BETA;
  let precSum = 0;
  let recSum = 0;
  let effectiveOrders = 0;
  for (const { match, hyp, ref } of stats) {
    if (hyp === 0 || ref === 0) continue;
    effectiveOrders++;
    precSum += match / hyp;
    recSum += match / ref;
  }
  if (effectiveOrders === 0) return 0;
  const avgPrec = precSum / effectiveOrders;
  const avgRec = recSum / effectiveOrders;
  const denom = betaSq * avgPrec + avgRec;
  if (denom === 0) return 0;
  return (((1 + betaSq) * avgPrec * avgRec) / denom) * 100;
}

/** Sentence-level chrF, 0..100. */
export function chrfScore(hypothesis: string, reference: string): number {
  return chrfFromStats(chrfStats(hypothesis, reference));
}

/** Corpus-level chrF: per-order stats summed over all pairs, then one F. */
export function corpusChrf(
  pairs: Array<{ hypothesis: string; reference: string }>,
): number {
  let total: ChrfOrderStats[] = Array.from({ length: CHAR_ORDER }, () => ({
    match: 0,
    hyp: 0,
    ref: 0,
  }));
  for (const { hypothesis, reference } of pairs) {
    total = addStats(total, chrfStats(hypothesis, reference));
  }
  return chrfFromStats(total);
}
