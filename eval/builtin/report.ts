/**
 * Score what `collect.mjs` recorded, with the metrics the model benchmark uses.
 *
 * Same 27 fixtures, same references, same chrF implementation, same artifact
 * detectors — so the built-in engine's number sits directly beside the model
 * table in `eval/BENCHMARK-RESULTS.md` rather than beside nothing.
 *
 * Separate from the collector because the collector runs inside a browser and
 * cannot be type-checked against Node's lib, while this half must be: it
 * imports the shipped `toTaiwanVocabulary`, which is the transform under test.
 *
 *   pnpm eval:builtin                # collect, then this
 *   pnpm eval:builtin:report         # this alone, from the recorded run
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toTaiwanVocabulary } from '../../src/core/tw-vocab';
import { hasEcho, hasPreamble, hasSimplifiedLeak } from '../detectors';
import { corpusChrf, chrfScore } from '../bench/chrf';

interface Record_ {
  id: string;
  domain: string;
  source: string;
  reference: string;
  raw: string;
  shipped: string;
  rawMs: number;
  shippedMs: number;
  error?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const RAW_PATH = join(here, '..', 'results', 'builtin-raw.json');
const REPORT_PATH = join(here, '..', 'BUILTIN-RESULTS.md');

if (!existsSync(RAW_PATH)) {
  console.error(`No recorded run at ${RAW_PATH}. Run \`pnpm eval:builtin\`.`);
  process.exit(1);
}
const records = JSON.parse(readFileSync(RAW_PATH, 'utf8')) as Record_[];
const ok = records.filter((r) => !r.error && r.shipped);

const percent = (n: number, total: number): string =>
  total === 0 ? '—' : `${((n / total) * 100).toFixed(1)}%`;

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

const count = (predicate: (r: Record_) => boolean): number =>
  ok.filter(predicate).length;

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;

const rawChrf = corpusChrf(
  ok.map((r) => ({ hypothesis: r.raw, reference: r.reference })),
);
const shippedChrf = corpusChrf(
  ok.map((r) => ({ hypothesis: r.shipped, reference: r.reference })),
);

// What the Taiwan-vocabulary pass actually did, rather than what it was
// believed to do: how many segments it changed at all, and whether the
// extension's output matches applying the same pure function here. Anything
// but zero mismatches would mean the shipped pipeline is not the function it
// is documented as.
const changed = ok.filter((r) => r.shipped !== r.raw);
const mismatched = ok.filter((r) => r.shipped !== toTaiwanVocabulary(r.raw));

const lines: string[] = [];
lines.push('# OpenRead — built-in engine quality');
lines.push('');
lines.push(
  `Chrome's on-device translator — the extension's **default engine** — over the same **${String(records.length)}** EN→zh-TW fixtures, the same references and the same chrF implementation \`pnpm bench\` uses, so these numbers sit directly beside the model table in [BENCHMARK-RESULTS.md](BENCHMARK-RESULTS.md). Regenerate with \`pnpm eval:builtin\`.`,
);
lines.push('');
lines.push(
  "_Recorded in a real Chrome with the built extension loaded. **shipped** is driven through the extension's own `stream-translate` port — the broker the content script talks to — so it is the text a reader is actually shown. **raw** is `Translator.translate()` called directly in the same browser and the same session, which is what Chrome returns before this extension touches it. The source language is declared rather than detected, so a detector miss cannot move a translation score._",
);
lines.push('');
lines.push('## Quality — corpus chrF against references');
lines.push('');
lines.push('| Condition | chrF | vs raw |');
lines.push('| --- | --- | --- |');
lines.push(`| Chrome, raw | ${rawChrf.toFixed(1)} | — |`);
lines.push(
  `| OpenRead, shipped | ${shippedChrf.toFixed(1)} | ${signed(shippedChrf - rawChrf)} |`,
);
lines.push('');
lines.push(
  `For scale: the best cell in [BENCHMARK-RESULTS.md](BENCHMARK-RESULTS.md) — \`qwen3:latest\`, engineered prompt, shipped pipeline — scores **46.4** on these same segments. So the engine that costs nothing to install is about ten chrF behind the one that costs a server and five gigabytes. Against that, a whole segment finishes here in ${median(ok.map((r) => r.shippedMs)).toFixed(0)} ms (p50, through the extension) while that model's *first character* arrives at 451 ms. That is the trade the default engine is making, in numbers, for the first time.`,
);
lines.push('');
lines.push('### By domain');
lines.push('');
lines.push(
  '_Where the engine is weak, rather than how weak it is on average. `tricky` is idiom, units and mixed code; `coll` is colloquial._',
);
lines.push('');
lines.push('| Domain | Segments | chrF |');
lines.push('| --- | --- | --- |');
for (const domain of [...new Set(ok.map((r) => r.domain))]) {
  const rows = ok.filter((r) => r.domain === domain);
  lines.push(
    `| ${domain} | ${String(rows.length)} | ${corpusChrf(
      rows.map((r) => ({ hypothesis: r.shipped, reference: r.reference })),
    ).toFixed(1)} |`,
  );
}
lines.push('');
lines.push('## The Taiwan vocabulary pass');
lines.push('');
lines.push(
  `Segments it rewrote: **${String(changed.length)}/${String(ok.length)}** (${percent(changed.length, ok.length)}), worth ${signed(shippedChrf - rawChrf)} corpus chrF. Segments where the shipped output differs from applying \`toTaiwanVocabulary\` to the raw output here: **${String(mismatched.length)}** — anything but zero would mean the shipped pipeline is not the pure function it is documented as.`,
);
lines.push('');
lines.push(
  `That is far below what \`core/tw-vocab.ts\` was built on: 32 substitutions in a single translated article, counted by hand. Both are true. The article was software documentation, where 本地, 運行, 代碼 and 用戶 are on every screen; this fixture set is mostly news, academic abstracts, interface copy and colloquial speech, and its ${String(ok.filter((r) => r.domain.startsWith('tech')).length)} technical segments are the only place the table has anything to catch. The finding is about the fixture set as much as about the pass — the corpus this project scores translation quality on barely covers the domain its one quality layer exists for.`,
);
lines.push('');
if (changed.length > 0) {
  lines.push('| Fixture | Δ chrF | Chrome wrote | OpenRead shows |');
  lines.push('| --- | --- | --- | --- |');
  for (const record of changed) {
    const delta =
      chrfScore(record.shipped, record.reference) -
      chrfScore(record.raw, record.reference);
    lines.push(
      `| ${record.id} | ${signed(delta)} | ${record.raw} | ${record.shipped} |`,
    );
  }
  lines.push('');
}
lines.push('## Artifacts');
lines.push('');
lines.push(
  '_The detectors `pnpm eval` runs on the Ollama path, pointed at this one. A statistical translator has no chat behaviour to strip, so zero across the board is the expected reading — the value of running them is that "expected" is not "measured"._',
);
lines.push('');
lines.push('| Detector | raw | shipped |');
lines.push('| --- | --- | --- |');
lines.push(
  `| Preamble | ${percent(
    count((r) => hasPreamble(r.raw)),
    ok.length,
  )} | ${percent(
    count((r) => hasPreamble(r.shipped)),
    ok.length,
  )} |`,
);
lines.push(
  `| Echo of the source | ${percent(
    count((r) => hasEcho(r.source, r.raw)),
    ok.length,
  )} | ${percent(
    count((r) => hasEcho(r.source, r.shipped)),
    ok.length,
  )} |`,
);
lines.push(
  `| Simplified leak | ${percent(
    count((r) => hasSimplifiedLeak(r.raw)),
    ok.length,
  )} | ${percent(
    count((r) => hasSimplifiedLeak(r.shipped)),
    ok.length,
  )} |`,
);
lines.push('');
lines.push('## Latency');
lines.push('');
lines.push(
  '_Per segment, with the language pack already downloaded. **Through the extension** carries a round trip to the service worker on top of the translation itself. The pack download is a once-per-pair cost, paid before the first timed call and excluded here — mistaking it for a per-use cost is what sent an earlier performance investigation down the wrong road._',
);
lines.push('');
lines.push('| Path | p50 (ms) | mean (ms) |');
lines.push('| --- | --- | --- |');
lines.push(
  `| Translator.translate | ${median(ok.map((r) => r.rawMs)).toFixed(0)} | ${mean(
    ok.map((r) => r.rawMs),
  ).toFixed(0)} |`,
);
lines.push(
  `| Through the extension | ${median(ok.map((r) => r.shippedMs)).toFixed(
    0,
  )} | ${mean(ok.map((r) => r.shippedMs)).toFixed(0)} |`,
);
lines.push('');

const failed = records.filter((r) => r.error);
if (failed.length > 0) {
  lines.push(`## Failures (${String(failed.length)})`);
  lines.push('');
  for (const record of failed) {
    lines.push(`- \`${record.id}\` — ${record.error ?? 'unknown'}`);
  }
  lines.push('');
}

lines.push('## Per fixture');
lines.push('');
lines.push('_Worst first, which is the useful order for a quality report._');
lines.push('');
lines.push('| Fixture | chrF | Shown to the reader |');
lines.push('| --- | --- | --- |');
for (const record of [...ok].sort(
  (a, b) =>
    chrfScore(a.shipped, a.reference) - chrfScore(b.shipped, b.reference),
)) {
  lines.push(
    `| ${record.id} | ${chrfScore(record.shipped, record.reference).toFixed(
      1,
    )} | ${record.shipped} |`,
  );
}
lines.push('');

lines.push('## What this does not say');
lines.push('');
lines.push(
  `- **${String(ok.length)} segments, one language pair, one Chrome.** Chrome ships a separate model per pair, so nothing here transfers to en→ja or ja→zh. A number for those is another run of this file away, and has not been run.`,
);
lines.push(
  '- **chrF against one reference is a proxy.** Each fixture has a single Taiwanese translation, and a different-but-correct rendering scores lower than a mediocre one that happens to share characters with it. The per-fixture table is there so the reader can check the metric against the text rather than take it.',
);
lines.push(
  '- **The worst scores here are idioms, not vocabulary.** "It\'s not rocket science" comes back as 這不是火箭科學 and "break a leg" as 打斷一條腿. No word-substitution table reaches those, and the eval exists partly to stop a table being extended in the hope that it might.',
);
lines.push(
  '- **Nothing here was tuned on these fixtures.** The vocabulary table predates this run. Adding entries picked by reading these outputs would raise this score and measure nothing, which is the failure mode this file was written to replace.',
);
lines.push('');

writeFileSync(REPORT_PATH, lines.join('\n'));
console.log(
  `corpus chrF: raw ${rawChrf.toFixed(1)} -> shipped ${shippedChrf.toFixed(1)}`,
);
console.log(
  `taiwan vocabulary rewrote ${String(changed.length)}/${String(ok.length)} segments`,
);
console.log(`wrote ${REPORT_PATH}`);
