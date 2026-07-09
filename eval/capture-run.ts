/**
 * Capture-enrichment eval — deterministic and offline.
 *
 * Small local models return metadata unreliably: wrapped in code fences, buried
 * in preamble, tags as a comma string, or nothing usable at all. This measures
 * how much the pure `parseEnrichResponse` salvager improves on a naive
 * `JSON.parse` over a fixture set of real small-model reply shapes. No network,
 * no Ollama server — reproducible in CI and honest to cite. Run with
 * `pnpm eval:capture`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnrichResponse } from '../src/core/enrich';

interface Fixture {
  id: string;
  category: string;
  raw: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, 'dataset', 'capture-fixtures.json'), 'utf8'),
) as Fixture[];

function naiveParses(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

const rows = fixtures.map((fixture) => {
  const parsed = parseEnrichResponse(fixture.raw);
  return {
    naive: naiveParses(fixture.raw),
    robust: parsed !== null,
    title: Boolean(parsed?.title),
    summary: Boolean(parsed?.summary),
    tags: (parsed?.tags?.length ?? 0) > 0,
  };
});

const total = fixtures.length;
const count = (predicate: (r: (typeof rows)[number]) => boolean): number =>
  rows.filter(predicate).length;

const naiveOk = count((r) => r.naive);
const robustOk = count((r) => r.robust);
const robustOnly = count((r) => r.robust && !r.naive);
const withTitle = count((r) => r.title);
const withSummary = count((r) => r.summary);
const withTags = count((r) => r.tags);

const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`;

const lines: string[] = [];
lines.push('# OpenRead — Capture Enrichment Eval');
lines.push('');
lines.push(
  `Offline, deterministic run over **${total}** small-model reply fixtures. ` +
    'No network, no Ollama server needed.',
);
lines.push('');
lines.push('| Metric | Count | Rate |');
lines.push('| --- | --- | --- |');
lines.push(
  `| Naive \`JSON.parse\` yields an object | ${naiveOk} | ${pct(naiveOk)} |`,
);
lines.push(
  `| Robust \`parseEnrichResponse\` yields usable metadata | ${robustOk} | ${pct(robustOk)} |`,
);
lines.push(`| Usable title recovered | ${withTitle} | ${pct(withTitle)} |`);
lines.push(
  `| Usable summary recovered | ${withSummary} | ${pct(withSummary)} |`,
);
lines.push(`| ≥1 tag recovered | ${withTags} | ${pct(withTags)} |`);
lines.push('');
lines.push(
  `_The robust parser recovers usable metadata from **${robustOnly}** replies ` +
    'that a naive `JSON.parse` drops (fenced, preamble-wrapped, or trailing-prose ' +
    'output), while rejecting empty/garbage replies that naive parsing would wave ' +
    'through. Enrichment is best-effort — every capture writes a raw note ' +
    'regardless._',
);
lines.push('');

const report = lines.join('\n');
console.log(report);
writeFileSync(join(here, 'CAPTURE-RESULTS.md'), report + '\n', 'utf8');
