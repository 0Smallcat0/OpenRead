/**
 * Reliability eval runner.
 *
 * Measures how much the pure "reliability layer" (preamble/echo/quote stripping
 * + OpenCC Simplified->Traditional conversion) improves raw model output on a
 * curated fixture set of real failure modes. Fully offline and deterministic —
 * no API key, no network — so the before/after numbers are reproducible in CI
 * and honest to cite. Run with `pnpm eval`.
 *
 * For live model quality scoring (LLM-as-judge) see `eval/judge.ts`, which is
 * opt-in and requires an OpenRouter key.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanTranslationOutput } from '../src/core/sanitize';
import { toTraditionalTW } from '../src/core/zh-convert';
import { hasPreamble, hasSimplifiedLeak, hasEcho } from './detectors';

interface Fixture {
  id: string;
  category: string;
  source: string;
  targetLang: string;
  rawOutput: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, 'dataset', 'fixtures.json'), 'utf8'),
) as Fixture[];

function wantsTraditional(targetLang: string): boolean {
  return (
    targetLang.includes('Traditional') ||
    targetLang.includes('繁體') ||
    targetLang.includes('Taiwan')
  );
}

/** The exact transform the production pipeline applies to a completed output. */
function applyReliabilityLayer(fixture: Fixture): string {
  const cleaned = cleanTranslationOutput(fixture.source, fixture.rawOutput);
  return wantsTraditional(fixture.targetLang)
    ? toTraditionalTW(cleaned)
    : cleaned;
}

interface Metric {
  name: string;
  applicable: number;
  before: number;
  after: number;
}

function rate(count: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((count / total) * 100).toFixed(1)}%`;
}

const tcFixtures = fixtures.filter((f) => wantsTraditional(f.targetLang));

const results: Array<{ fixture: Fixture; after: string }> = fixtures.map(
  (fixture) => ({ fixture, after: applyReliabilityLayer(fixture) }),
);

const metrics: Metric[] = [
  {
    name: 'Preamble / thinking leakage',
    applicable: fixtures.length,
    before: fixtures.filter((f) => hasPreamble(f.rawOutput)).length,
    after: results.filter((r) => hasPreamble(r.after)).length,
  },
  {
    name: 'Input echo',
    applicable: fixtures.length,
    before: fixtures.filter((f) => hasEcho(f.source, f.rawOutput)).length,
    after: results.filter((r) => hasEcho(r.fixture.source, r.after)).length,
  },
  {
    name: 'Simplified leakage (TC targets)',
    applicable: tcFixtures.length,
    before: tcFixtures.filter((f) => hasSimplifiedLeak(f.rawOutput)).length,
    after: results
      .filter((r) => wantsTraditional(r.fixture.targetLang))
      .filter((r) => hasSimplifiedLeak(r.after)).length,
  },
];

function reduction(before: number, after: number): string {
  if (before === 0) return '—';
  return `${(((before - after) / before) * 100).toFixed(0)}%`;
}

const lines: string[] = [];
lines.push('# OpenRead — Reliability Eval Results');
lines.push('');
lines.push(
  `Offline, deterministic run over **${fixtures.length}** curated fixtures ` +
    `(${tcFixtures.length} Traditional-Chinese targets). No network, no Ollama server needed.`,
);
lines.push('');
lines.push('| Metric | Applicable | Before | After | Reduction |');
lines.push('| --- | --- | --- | --- | --- |');
for (const m of metrics) {
  lines.push(
    `| ${m.name} | ${m.applicable} | ${m.before} (${rate(m.before, m.applicable)}) ` +
      `| ${m.after} (${rate(m.after, m.applicable)}) | ${reduction(m.before, m.after)} |`,
  );
}
lines.push('');
lines.push(
  '_Before = raw model output. After = output passed through the pure ' +
    'reliability layer (`cleanTranslationOutput` + OpenCC `s2twp`)._',
);
lines.push('');

const report = lines.join('\n');
console.log(report);
writeFileSync(join(here, 'RESULTS.md'), report + '\n', 'utf8');
