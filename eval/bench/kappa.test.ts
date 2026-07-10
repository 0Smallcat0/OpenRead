import { describe, expect, it } from 'vitest';
import { cohenKappa, weightedKappa } from './kappa';

/** Expand a confusion-matrix spec into two aligned rating lists. */
function expand(
  cells: Array<[a: number, b: number, count: number]>,
): [number[], number[]] {
  const a: number[] = [];
  const b: number[] = [];
  for (const [ra, rb, count] of cells) {
    for (let i = 0; i < count; i++) {
      a.push(ra);
      b.push(rb);
    }
  }
  return [a, b];
}

describe('cohenKappa', () => {
  it('matches the textbook 2x2 example (po=0.7, pe=0.5 → κ=0.4)', () => {
    // 20 yes/yes, 15 no/no, 10 yes/no, 5 no/yes over 50 items.
    const [a, b] = expand([
      [1, 1, 20],
      [0, 0, 15],
      [1, 0, 10],
      [0, 1, 5],
    ]);
    expect(cohenKappa(a, b, [0, 1])).toBeCloseTo(0.4, 10);
  });

  it('is 1 for perfect agreement', () => {
    expect(cohenKappa([1, 2, 3, 1], [1, 2, 3, 1], [1, 2, 3])).toBe(1);
  });

  it('is 0 for chance-level agreement', () => {
    // Rater B says 1 half the time regardless of A: po = pe.
    const [a, b] = expand([
      [1, 1, 5],
      [1, 2, 5],
      [2, 1, 5],
      [2, 2, 5],
    ]);
    expect(cohenKappa(a, b, [1, 2])).toBeCloseTo(0, 10);
  });

  it('can be negative for systematic disagreement', () => {
    const [a, b] = expand([
      [1, 2, 10],
      [2, 1, 10],
    ]);
    expect(cohenKappa(a, b, [1, 2])).toBeLessThan(0);
  });

  it('throws on mismatched lengths', () => {
    expect(() => cohenKappa([1], [1, 2], [1, 2])).toThrow(/differ in length/);
  });

  it('throws on empty input', () => {
    expect(() => cohenKappa([], [], [1, 2])).toThrow(/zero items/);
  });

  it('throws on out-of-category ratings', () => {
    expect(() => cohenKappa([9], [1], [1, 2])).toThrow(/outside categories/);
  });
});

describe('weightedKappa (quadratic)', () => {
  it('is 1 for perfect agreement', () => {
    expect(weightedKappa([1, 3, 5], [1, 3, 5], [1, 2, 3, 4, 5])).toBe(1);
  });

  it('is -1 for perfectly reversed ratings on a uniform 3-scale', () => {
    // Hand-computed: Σd·O = 2, Σd·E = 1 → κw = 1 - 2/1 = -1.
    expect(weightedKappa([1, 2, 3], [3, 2, 1], [1, 2, 3])).toBeCloseTo(-1, 10);
  });

  it('penalises near-misses less than the unweighted kappa', () => {
    // All disagreements are adjacent (4 vs 5): unweighted sees pure
    // disagreement, quadratic weighting forgives most of it.
    const [a, b] = expand([
      [5, 4, 5],
      [4, 5, 5],
      [1, 1, 5],
      [2, 2, 5],
    ]);
    const cats = [1, 2, 3, 4, 5];
    expect(weightedKappa(a, b, cats)).toBeGreaterThan(cohenKappa(a, b, cats));
  });

  it('hand-checked mixed example', () => {
    // Ratings over categories 1..3, N=4:
    //   items: (1,1) (2,3) (3,3) (3,2)
    // O-cells: (0,0)=1 (1,2)=1 (2,2)=1 (2,1)=1; d(i,j)=(i-j)^2/4
    // Σd·O = 0 + 0.25 + 0 + 0.25 = 0.5
    // row marg = [1,1,2], col marg = [1,1,2]
    // Σd·E = Σ d(i,j)·row_i·col_j/4
    //   d01·1·1 + d02·1·2 + d10·1·1 + d12·1·2 + d20·2·1 + d21·2·1  (all /4)
    //   = (0.25 + 2 + 0.25 + 0.5 + 2 + 0.5)/4 = 5.5/4 = 1.375
    // κw = 1 - 0.5/1.375 = 0.636363...
    expect(weightedKappa([1, 2, 3, 3], [1, 3, 3, 2], [1, 2, 3])).toBeCloseTo(
      1 - 0.5 / 1.375,
      10,
    );
  });
});
