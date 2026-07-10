/**
 * Cohen's kappa — inter-rater agreement corrected for chance. Used to
 * calibrate the LLM judge against human labels: raw percent agreement is
 * inflated by chance on skewed rating distributions, kappa is not.
 *
 * Two variants:
 *   - cohenKappa:    unweighted, for categorical labels.
 *   - weightedKappa: quadratic weights, for ordinal scales (1–5 ratings),
 *     where a 4-vs-5 disagreement should cost less than 1-vs-5.
 *
 * Pure and dependency-free; verified against hand-computed textbook examples.
 */

function buildConfusion(
  a: number[],
  b: number[],
  categories: number[],
): number[][] {
  if (a.length !== b.length) {
    throw new Error(`Rating lists differ in length: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) throw new Error('Cannot compute kappa on zero items');
  const index = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    const ra = va === undefined ? undefined : index.get(va);
    const rb = vb === undefined ? undefined : index.get(vb);
    const row = ra === undefined ? undefined : matrix[ra];
    if (row === undefined || rb === undefined) {
      throw new Error(
        `Rating outside categories at item ${i}: ${String(va)}/${String(vb)}`,
      );
    }
    row[rb] = (row[rb] ?? 0) + 1;
  }
  return matrix;
}

function marginals(matrix: number[][]): { row: number[]; col: number[] } {
  const k = matrix.length;
  const row = new Array<number>(k).fill(0);
  const col = new Array<number>(k).fill(0);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const value = matrix[i]?.[j] ?? 0;
      row[i] = (row[i] ?? 0) + value;
      col[j] = (col[j] ?? 0) + value;
    }
  }
  return { row, col };
}

/** Unweighted Cohen's kappa over two raters' labels. */
export function cohenKappa(
  a: number[],
  b: number[],
  categories: number[],
): number {
  const matrix = buildConfusion(a, b, categories);
  const n = a.length;
  const { row, col } = marginals(matrix);
  const k = categories.length;

  let observed = 0;
  for (let i = 0; i < k; i++) observed += matrix[i]?.[i] ?? 0;
  const po = observed / n;

  let pe = 0;
  for (let i = 0; i < k; i++) pe += ((row[i] ?? 0) * (col[i] ?? 0)) / (n * n);

  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/** Quadratically weighted Cohen's kappa for ordinal categories (in order). */
export function weightedKappa(
  a: number[],
  b: number[],
  categories: number[],
): number {
  const matrix = buildConfusion(a, b, categories);
  const n = a.length;
  const { row, col } = marginals(matrix);
  const k = categories.length;
  if (k < 2) return 1;

  const denomScale = (k - 1) * (k - 1);
  let weightedObserved = 0;
  let weightedExpected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const disagreement = ((i - j) * (i - j)) / denomScale;
      weightedObserved += disagreement * (matrix[i]?.[j] ?? 0);
      weightedExpected += disagreement * (((row[i] ?? 0) * (col[j] ?? 0)) / n);
    }
  }

  if (weightedExpected === 0) return weightedObserved === 0 ? 1 : 0;
  return 1 - weightedObserved / weightedExpected;
}
