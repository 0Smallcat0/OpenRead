/**
 * Judge calibration — how much can the LLM judge be trusted?
 *
 * An LLM judge is only evidence if its ratings track human judgement, so this
 * script closes the loop in two steps:
 *
 *   1. `pnpm bench:agreement -- --make-page [n]`
 *      Samples n judged items (default 40, seeded PRNG, stratified across
 *      model × condition cells) into `eval/results/labeling.html` — a
 *      self-contained page where a human rates the same outputs on the same
 *      1–5 rubric, blind to the judge's scores and to which model produced
 *      what. The page exports `human-labels.json`.
 *
 *   2. `pnpm bench:agreement` (labels saved to `eval/dataset/human-labels.json`)
 *      Reports per-axis agreement between judge and human: raw percent,
 *      unweighted Cohen's kappa, and quadratically weighted kappa (ordinal
 *      scales should forgive 4-vs-5 more than 1-vs-5). Writes
 *      `eval/AGREEMENT.md`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cohenKappa, weightedKappa } from './kappa';

interface GenerationRecord {
  model: string;
  condition: 'naive' | 'engineered';
  fixtureId: string;
  raw: string;
  piped: string;
  error?: string;
}
interface JudgeScore {
  adequacy: number;
  fluency: number;
  localization: number;
}
interface Checkpoint {
  generations: Record<string, GenerationRecord>;
  judgements: Record<string, { score?: JudgeScore }>;
}
interface Fixture {
  id: string;
  source: string;
  reference: string;
}
interface HumanLabel extends JudgeScore {
  key: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const checkpointPath = join(here, '..', 'results', 'bench-raw.json');
const labelsPath = join(here, '..', 'dataset', 'human-labels.json');
const pagePath = join(here, '..', 'results', 'labeling.html');
const reportPath = join(here, '..', 'AGREEMENT.md');

const AXES = ['adequacy', 'fluency', 'localization'] as const;
const CATEGORIES = [1, 2, 3, 4, 5];

function loadCheckpoint(): Checkpoint {
  return JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
}
function loadFixtures(): Map<string, Fixture> {
  const fixtures = JSON.parse(
    readFileSync(join(here, '..', 'dataset', 'bench-fixtures.json'), 'utf8'),
  ) as Fixture[];
  return new Map(fixtures.map((f) => [f.id, f]));
}

/** The same output the judge graded: raw for naive, piped for engineered. */
function judgedOutput(record: GenerationRecord): string {
  return record.condition === 'naive' ? record.raw : record.piped;
}

/** Deterministic PRNG so the sampled page is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePage(sampleSize: number): void {
  const checkpoint = loadCheckpoint();
  const fixtures = loadFixtures();

  const judged = Object.entries(checkpoint.judgements)
    .filter(([, j]) => j.score)
    .map(([key]) => key)
    .sort();
  if (judged.length === 0) {
    console.error(
      'No judged items in the checkpoint — run `pnpm bench` first.',
    );
    process.exitCode = 1;
    return;
  }

  // Stratify: round-robin across model|condition cells, random within each.
  const random = mulberry32(42);
  const byCell = new Map<string, string[]>();
  for (const key of judged) {
    const [model, condition] = key.split('|');
    const cell = `${model}|${condition}`;
    byCell.set(cell, [...(byCell.get(cell) ?? []), key]);
  }
  for (const keys of byCell.values()) {
    keys.sort(() => random() - 0.5);
  }
  const sampled: string[] = [];
  const cells = [...byCell.values()];
  for (
    let round = 0;
    sampled.length < Math.min(sampleSize, judged.length);
    round++
  ) {
    let advanced = false;
    for (const keys of cells) {
      const key = keys[round];
      if (key === undefined) continue;
      advanced = true;
      sampled.push(key);
      if (sampled.length >= Math.min(sampleSize, judged.length)) break;
    }
    if (!advanced) break;
  }
  // Shuffle presentation order so consecutive items don't share a model.
  sampled.sort(() => random() - 0.5);

  const items = sampled.map((key) => {
    const record = checkpoint.generations[key];
    const fixture = record ? fixtures.get(record.fixtureId) : undefined;
    return {
      key,
      source: fixture?.source ?? '',
      reference: fixture?.reference ?? '',
      candidate: record ? judgedOutput(record) : '',
    };
  });

  const html = `<!doctype html>
<meta charset="utf-8">
<title>OpenRead — human labeling (${items.length} items)</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
  .item { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .label { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  .axis { margin: .4rem 0; }
  .axis span { display: inline-block; width: 8.5em; }
  button { font-size: 16px; padding: .5rem 1.2rem; margin: 1rem 0 3rem; }
  .hint { color: #666; font-size: 13px; }
  progress { width: 100%; }
</style>
<h1>OpenRead — human labels</h1>
<p class="hint">Rate each CANDIDATE 1–5 per axis (adequacy = meaning preserved;
fluency = natural Traditional Chinese; localization = Taiwan script &amp;
terminology, 1 if Simplified characters appear). Model identities are hidden.
When done, click <b>Export</b> and save the file as
<code>eval/dataset/human-labels.json</code>, then run
<code>pnpm bench:agreement</code>.</p>
<progress id="p" max="${items.length}" value="0"></progress>
<div id="items"></div>
<button onclick="exportLabels()">Export human-labels.json</button>
<script>
const ITEMS = ${JSON.stringify(items)};
const AXES = ${JSON.stringify(AXES)};
const container = document.getElementById('items');
for (const [i, item] of ITEMS.entries()) {
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML =
    '<div class="label">#' + (i + 1) + ' — source</div><div>' + esc(item.source) + '</div>' +
    '<div class="label">reference</div><div>' + esc(item.reference) + '</div>' +
    '<div class="label">candidate</div><div><b>' + esc(item.candidate) + '</b></div>' +
    AXES.map(axis =>
      '<div class="axis"><span>' + axis + '</span>' +
      [1,2,3,4,5].map(v =>
        '<label><input type="radio" name="' + axis + '-' + i + '" value="' + v + '" onchange="tick()"> ' + v + '</label> '
      ).join('') + '</div>'
    ).join('');
  container.appendChild(div);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function tick() {
  const done = ITEMS.filter((_, i) => AXES.every(a => document.querySelector('input[name="' + a + '-' + i + '"]:checked'))).length;
  document.getElementById('p').value = done;
}
function exportLabels() {
  const labels = [];
  for (const [i, item] of ITEMS.entries()) {
    const scores = {};
    for (const axis of AXES) {
      const checked = document.querySelector('input[name="' + axis + '-' + i + '"]:checked');
      if (!checked) { alert('Item #' + (i + 1) + ' is missing a ' + axis + ' rating.'); return; }
      scores[axis] = Number(checked.value);
    }
    labels.push({ key: item.key, ...scores });
  }
  const blob = new Blob([JSON.stringify(labels, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'human-labels.json';
  a.click();
}
</script>`;
  writeFileSync(pagePath, html, 'utf8');
  console.log(`Wrote ${pagePath} with ${items.length} items.`);
}

function computeAgreement(): void {
  if (!existsSync(labelsPath)) {
    console.error(
      `No human labels at ${labelsPath}.\n` +
        'Generate the labeling page with `pnpm bench:agreement -- --make-page`, ' +
        'rate the items, save the export there, then re-run.',
    );
    process.exitCode = 1;
    return;
  }
  const checkpoint = loadCheckpoint();
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as HumanLabel[];

  const lines: string[] = [];
  lines.push('# OpenRead — Judge ↔ Human Agreement');
  lines.push('');
  lines.push(
    `Cohen's kappa between the LLM judge and **${labels.length}** human-rated ` +
      'items (1–5 scales). Quadratic weighting is the headline number for ' +
      'ordinal ratings; ≥0.4 = moderate, ≥0.6 = substantial agreement.',
  );
  lines.push('');
  lines.push('| Axis | Raw agreement | Cohen κ | Weighted κ (quadratic) | n |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const axis of AXES) {
    const human: number[] = [];
    const judge: number[] = [];
    for (const label of labels) {
      const score = checkpoint.judgements[label.key]?.score;
      if (!score) continue;
      human.push(label[axis]);
      judge.push(score[axis]);
    }
    if (human.length === 0) continue;
    const exact = human.filter((h, i) => h === judge[i]).length / human.length;
    lines.push(
      `| ${axis} | ${(exact * 100).toFixed(1)}% ` +
        `| ${cohenKappa(human, judge, CATEGORIES).toFixed(3)} ` +
        `| ${weightedKappa(human, judge, CATEGORIES).toFixed(3)} ` +
        `| ${human.length} |`,
    );
  }
  lines.push('');
  const report = lines.join('\n');
  writeFileSync(reportPath, report + '\n', 'utf8');
  console.log(report);
}

const pageFlag = process.argv.indexOf('--make-page');
if (pageFlag >= 0) {
  makePage(Number(process.argv[pageFlag + 1]) || 40);
} else {
  computeAgreement();
}
