/**
 * Live translation benchmark — model × prompt matrix over the curated
 * EN→Traditional-Chinese fixture set, scored with reference-based chrF,
 * artifact detectors, latency, and an LLM judge.
 *
 * Product fidelity: generations go through the SAME code path the extension
 * ships — `buildMessages` for the prompt, `/v1/chat/completions` SSE parsed by
 * `extractDelta`, assembled by `StreamAssembler` with the OpenCC transform —
 * so every number describes shipped behaviour, not a lab approximation. The
 * only additions are a fixed seed (reproducibility) and timing probes.
 *
 * Judge calls use Ollama's native `/api/chat` with a constrained JSON-schema
 * `format` and `think: false` — the judge is infrastructure, not the system
 * under test, so it does not need the product code path.
 *
 * Requires a local Ollama server; NOT wired into CI (the offline `pnpm eval`
 * stays the deterministic gate). Results checkpoint after every cell, so an
 * interrupted run resumes where it stopped:
 *
 *   pnpm bench                       # full matrix + judge + report
 *   pnpm bench -- --models qwen3:latest --fixtures news-01 --skip-judge
 *   pnpm bench -- --report-only      # regenerate the report from checkpoints
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildMessages, extractChunk } from '../../src/api/ollama';
import { StreamAssembler } from '../../src/core/stream';
import { toTraditionalTW } from '../../src/core/zh-convert';
import { hasEcho, hasPreamble, hasSimplifiedLeak } from '../detectors';
import { chrfStats, addStats, chrfFromStats, CHAR_ORDER } from './chrf';
import type { ChatMessage } from '../../src/core/types';

// --- configuration -----------------------------------------------------------

const TARGET_LANG = 'Traditional Chinese';
const TEMPERATURE = 0.3; // the extension's first-attempt temperature
const SEED = 42;
const REQUEST_TIMEOUT_MS = 300_000;

const DEFAULT_MODELS = [
  'qwen3.5:latest',
  'qwen3:latest',
  'llama3.1:latest',
  'deepseek-r1:8b',
];

export type ConditionId = 'naive' | 'engineered';
const CONDITIONS: ConditionId[] = ['naive', 'engineered'];

/**
 * The baseline any first implementation would use: a bare instruction, no
 * system prompt, no few-shot, no output-format rules.
 */
function naiveMessages(text: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: `Translate the following text to Traditional Chinese:\n\n${text}`,
    },
  ];
}

function messagesFor(condition: ConditionId, text: string): ChatMessage[] {
  return condition === 'naive'
    ? naiveMessages(text)
    : buildMessages(text, TARGET_LANG);
}

// --- types -------------------------------------------------------------------

interface Fixture {
  id: string;
  domain: string;
  source: string;
  reference: string;
  note: string;
}

interface GenerationRecord {
  model: string;
  condition: ConditionId;
  fixtureId: string;
  /** Concatenated raw content deltas — what the model actually emitted. */
  raw: string;
  /** Characters of hidden chain-of-thought (kept out of content by Ollama). */
  thinkingChars: number;
  /** Output of the shipped streaming pipeline (StreamAssembler + OpenCC). */
  piped: string;
  /** ms from request start to the first SSE content delta. */
  ttftNetMs: number | null;
  /** ms from request start to the first text the UI would paint. */
  ttftUiMs: number | null;
  totalMs: number;
  completionTokens: number | null;
  error?: string;
}

interface JudgeScore {
  adequacy: number;
  fluency: number;
  localization: number;
}

interface JudgeRecord {
  key: string;
  score?: JudgeScore;
  error?: string;
}

interface Checkpoint {
  meta: {
    baseUrl: string;
    targetLang: string;
    temperature: number;
    seed: number;
    judgeModel: string;
    startedAt: string;
  };
  generations: Record<string, GenerationRecord>;
  judgements: Record<string, JudgeRecord>;
}

// --- CLI / files -------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, '..', 'results');
const checkpointPath = join(resultsDir, 'bench-raw.json');
const reportPath = join(here, '..', 'BENCHMARK-RESULTS.md');

const baseUrl = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(
  /\/+$/,
  '',
);
const judgeModel = process.env.JUDGE_MODEL ?? 'qwen3.5:latest';

function argList(flag: string): string[] | null {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) return null;
  return value.split(',').map((s) => s.trim());
}
const onlyModels = argList('--models');
const onlyFixtures = argList('--fixtures');
const skipJudge = process.argv.includes('--skip-judge');
const reportOnly = process.argv.includes('--report-only');

const fixtures = (
  JSON.parse(
    readFileSync(join(here, '..', 'dataset', 'bench-fixtures.json'), 'utf8'),
  ) as Fixture[]
).filter((f) => !onlyFixtures || onlyFixtures.includes(f.id));

const models = (onlyModels ?? DEFAULT_MODELS).slice();

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
  } catch {
    return {
      meta: {
        baseUrl,
        targetLang: TARGET_LANG,
        temperature: TEMPERATURE,
        seed: SEED,
        judgeModel,
        startedAt: new Date().toISOString(),
      },
      generations: {},
      judgements: {},
    };
  }
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 1), 'utf8');
}

const cellKey = (model: string, condition: string, fixtureId: string) =>
  `${model}|${condition}|${fixtureId}`;

// --- generation --------------------------------------------------------------

/**
 * Stream one translation exactly the way the extension does, with timing
 * probes around the shipped parsing/assembly path.
 */
async function generate(
  model: string,
  condition: ConditionId,
  fixture: Fixture,
): Promise<GenerationRecord> {
  const record: GenerationRecord = {
    model,
    condition,
    fixtureId: fixture.id,
    raw: '',
    thinkingChars: 0,
    piped: '',
    ttftNetMs: null,
    ttftUiMs: null,
    totalMs: 0,
    completionTokens: null,
  };

  const assembler = new StreamAssembler({ transform: toTraditionalTW });
  const emitted: string[] = [];
  const t0 = performance.now();

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: messagesFor(condition, fixture.source),
        stream: true,
        think: false,
        options: { temperature: TEMPERATURE, seed: SEED },
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lineBuffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const chunk = extractChunk(line);
        if (chunk === null) continue;
        if (chunk.evalCount !== undefined) {
          record.completionTokens = chunk.evalCount;
        }
        record.thinkingChars += chunk.thinking.length;
        if (chunk.content === '') continue;
        if (record.ttftNetMs === null) {
          record.ttftNetMs = performance.now() - t0;
        }
        record.raw += chunk.content;
        const emit = assembler.push(chunk.content);
        if (emit) {
          if (record.ttftUiMs === null) {
            record.ttftUiMs = performance.now() - t0;
          }
          emitted.push(emit);
        }
      }
    }
    const tail = assembler.end();
    if (tail) {
      if (record.ttftUiMs === null) record.ttftUiMs = performance.now() - t0;
      emitted.push(tail);
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }

  record.totalMs = performance.now() - t0;
  record.piped = emitted.join('');
  return record;
}

// --- judge -------------------------------------------------------------------

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    adequacy: { type: 'integer', minimum: 1, maximum: 5 },
    fluency: { type: 'integer', minimum: 1, maximum: 5 },
    localization: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['adequacy', 'fluency', 'localization'],
} as const;

function judgePrompt(fixture: Fixture, candidate: string): string {
  return [
    'You are grading one machine translation from English into Traditional Chinese (Taiwan).',
    '',
    `SOURCE (English): ${fixture.source}`,
    `REFERENCE (a good human translation): ${fixture.reference}`,
    `CANDIDATE (the translation to grade): ${candidate}`,
    '',
    'Score the CANDIDATE on three axes, each an integer 1-5:',
    '- adequacy: meaning preserved. 5 = complete and correct; 3 = noticeable omissions or errors; 1 = wrong or unrelated. Non-translation text (explanations, the English source echoed back, reasoning) lowers adequacy.',
    '- fluency: natural Traditional Chinese. 5 = reads like a native text; 3 = understandable but awkward; 1 = broken or not Chinese.',
    '- localization: Taiwan conventions. 5 = Traditional script with Taiwan terminology throughout; 3 = Traditional script but mainland terminology; 1 = Simplified characters present.',
    '',
    'Grade only what is in CANDIDATE. Reply with the JSON object only.',
  ].join('\n');
}

/** Judge one candidate via native /api/chat with a constrained JSON schema. */
async function judge(fixture: Fixture, candidate: string): Promise<JudgeScore> {
  const body: Record<string, unknown> = {
    model: judgeModel,
    messages: [{ role: 'user', content: judgePrompt(fixture, candidate) }],
    stream: false,
    format: JUDGE_SCHEMA,
    think: false,
    options: { temperature: 0, seed: SEED },
  };
  let response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Some models reject the think flag — retry without it.
    delete body.think;
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (!response.ok) throw new Error(`judge HTTP ${response.status}`);

  const data = (await response.json()) as {
    message?: { content?: string };
  };
  const parsed = JSON.parse(data.message?.content ?? '') as JudgeScore;
  for (const key of ['adequacy', 'fluency', 'localization'] as const) {
    const value = parsed[key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`judge returned invalid ${key}: ${String(value)}`);
    }
  }
  return parsed;
}

/** The two end-to-end experiences worth judging per (model, fixture). */
function judgedOutput(record: GenerationRecord): string | null {
  if (record.error) return null;
  return record.condition === 'naive' ? record.raw : record.piped;
}

// --- scoring / report ----------------------------------------------------------

interface CellAggregate {
  model: string;
  condition: ConditionId;
  count: number;
  errors: number;
  chrfRaw: number;
  chrfPiped: number;
  preambleRaw: number;
  preamblePiped: number;
  echoRaw: number;
  echoPiped: number;
  simplifiedRaw: number;
  simplifiedPiped: number;
  ttftNetP50: number | null;
  ttftUiP50: number | null;
  tokensPerSec: number | null;
  judgeMeans: {
    adequacy: number;
    fluency: number;
    localization: number;
  } | null;
  judged: number;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index] ?? null;
}

function aggregate(checkpoint: Checkpoint): CellAggregate[] {
  const byFixture = new Map(fixtures.map((f) => [f.id, f]));
  const cells: CellAggregate[] = [];

  for (const model of models) {
    for (const condition of CONDITIONS) {
      const records = Object.values(checkpoint.generations).filter(
        (r) =>
          r.model === model &&
          r.condition === condition &&
          byFixture.has(r.fixtureId),
      );
      if (records.length === 0) continue;
      const ok = records.filter((r) => !r.error);

      let statsRaw = Array.from({ length: CHAR_ORDER }, () => ({
        match: 0,
        hyp: 0,
        ref: 0,
      }));
      let statsPiped = statsRaw.map((s) => ({ ...s }));
      const ttftNet: number[] = [];
      const ttftUi: number[] = [];
      let tokenSum = 0;
      let tokenTimeMs = 0;
      let preambleRaw = 0;
      let preamblePiped = 0;
      let echoRaw = 0;
      let echoPiped = 0;
      let simplifiedRaw = 0;
      let simplifiedPiped = 0;

      for (const r of ok) {
        const fixture = byFixture.get(r.fixtureId);
        if (!fixture) continue;
        statsRaw = addStats(statsRaw, chrfStats(r.raw, fixture.reference));
        statsPiped = addStats(
          statsPiped,
          chrfStats(r.piped, fixture.reference),
        );
        if (hasPreamble(r.raw)) preambleRaw++;
        if (hasPreamble(r.piped)) preamblePiped++;
        if (hasEcho(fixture.source, r.raw)) echoRaw++;
        if (hasEcho(fixture.source, r.piped)) echoPiped++;
        if (hasSimplifiedLeak(r.raw)) simplifiedRaw++;
        if (hasSimplifiedLeak(r.piped)) simplifiedPiped++;
        if (r.ttftNetMs !== null) ttftNet.push(r.ttftNetMs);
        if (r.ttftUiMs !== null) ttftUi.push(r.ttftUiMs);
        if (r.completionTokens !== null && r.ttftNetMs !== null) {
          tokenSum += r.completionTokens;
          tokenTimeMs += r.totalMs - r.ttftNetMs;
        }
      }

      const judgeScores = ok
        .map(
          (r) =>
            checkpoint.judgements[cellKey(r.model, r.condition, r.fixtureId)]
              ?.score,
        )
        .filter((s): s is JudgeScore => Boolean(s));

      cells.push({
        model,
        condition,
        count: records.length,
        errors: records.length - ok.length,
        chrfRaw: chrfFromStats(statsRaw),
        chrfPiped: chrfFromStats(statsPiped),
        preambleRaw,
        preamblePiped,
        echoRaw,
        echoPiped,
        simplifiedRaw,
        simplifiedPiped,
        ttftNetP50: percentile(ttftNet, 0.5),
        ttftUiP50: percentile(ttftUi, 0.5),
        tokensPerSec: tokenTimeMs > 0 ? (tokenSum / tokenTimeMs) * 1000 : null,
        judgeMeans:
          judgeScores.length > 0
            ? {
                adequacy:
                  judgeScores.reduce((s, j) => s + j.adequacy, 0) /
                  judgeScores.length,
                fluency:
                  judgeScores.reduce((s, j) => s + j.fluency, 0) /
                  judgeScores.length,
                localization:
                  judgeScores.reduce((s, j) => s + j.localization, 0) /
                  judgeScores.length,
              }
            : null,
        judged: judgeScores.length,
      });
    }
  }
  return cells;
}

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${Math.round(ms)}`;
}
function fmtRate(count: number, total: number): string {
  if (total === 0) return '—';
  return `${((count / total) * 100).toFixed(1)}%`;
}
function fmt(n: number | null | undefined, digits = 1): string {
  return n === null || n === undefined ? '—' : n.toFixed(digits);
}

function writeReport(checkpoint: Checkpoint): void {
  const cells = aggregate(checkpoint);
  const total = Object.values(checkpoint.generations).length;
  const lines: string[] = [];

  lines.push('# OpenRead — Translation Benchmark');
  lines.push('');
  lines.push(
    `Live model × prompt matrix over **${fixtures.length}** curated EN→zh-TW fixtures ` +
      `(${total} generations recorded). Generations run through the exact shipped ` +
      'pipeline (`buildMessages` → native `/api/chat` NDJSON, `think: false` → ' +
      '`extractChunk` → `StreamAssembler` + OpenCC). Decoding: temperature ' +
      `${checkpoint.meta.temperature}, seed ${checkpoint.meta.seed}. ` +
      `Judge: \`${checkpoint.meta.judgeModel}\` (native \`/api/chat\`, JSON-schema ` +
      'constrained, temperature 0). Regenerate with `pnpm bench`.',
  );
  lines.push('');

  lines.push('## Quality — corpus chrF against references');
  lines.push('');
  lines.push(
    '| Model | Prompt | chrF raw | chrF shipped pipeline | Δ pipeline |',
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of cells) {
    lines.push(
      `| ${c.model} | ${c.condition} | ${fmt(c.chrfRaw)} | ${fmt(c.chrfPiped)} | ` +
        `${fmt(c.chrfPiped - c.chrfRaw)} |`,
    );
  }
  lines.push('');

  lines.push('## Streaming artifacts — raw vs shipped pipeline');
  lines.push('');
  lines.push(
    '| Model | Prompt | Preamble raw→piped | Echo raw→piped | Simplified raw→piped |',
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of cells) {
    const okCount = c.count - c.errors;
    lines.push(
      `| ${c.model} | ${c.condition} ` +
        `| ${fmtRate(c.preambleRaw, okCount)} → ${fmtRate(c.preamblePiped, okCount)} ` +
        `| ${fmtRate(c.echoRaw, okCount)} → ${fmtRate(c.echoPiped, okCount)} ` +
        `| ${fmtRate(c.simplifiedRaw, okCount)} → ${fmtRate(c.simplifiedPiped, okCount)} |`,
    );
  }
  lines.push('');

  lines.push('## Latency');
  lines.push('');
  lines.push(
    '_TTFT-net = first content token off the wire; TTFT-UI = first text the panel paints ' +
      '(after the reluctant buffer). The gap is the price of preamble filtering; ' +
      'for reasoning models the wait is dominated by hidden thinking._',
  );
  lines.push('');
  lines.push(
    '| Model | Prompt | TTFT-net p50 (ms) | TTFT-UI p50 (ms) | Tokens/s | Errors |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of cells) {
    lines.push(
      `| ${c.model} | ${c.condition} | ${fmtMs(c.ttftNetP50)} | ${fmtMs(c.ttftUiP50)} ` +
        `| ${fmt(c.tokensPerSec)} | ${c.errors}/${c.count} |`,
    );
  }
  lines.push('');

  lines.push('## LLM-judge quality (1–5)');
  lines.push('');
  lines.push(
    '_Judged end-to-end experiences: `naive` = raw baseline output, `engineered` = ' +
      'shipped pipeline output. Reference-based grading; see `docs/BENCHMARK.md` ' +
      'for judge calibration against human labels._',
  );
  lines.push('');
  lines.push(
    '| Model | Prompt | Adequacy | Fluency | TW localization | Judged |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of cells) {
    lines.push(
      `| ${c.model} | ${c.condition} | ${fmt(c.judgeMeans?.adequacy, 2)} ` +
        `| ${fmt(c.judgeMeans?.fluency, 2)} | ${fmt(c.judgeMeans?.localization, 2)} ` +
        `| ${c.judged}/${c.count - c.errors} |`,
    );
  }
  lines.push('');
  lines.push(
    `_Hardware: local Ollama (${checkpoint.meta.baseUrl}). Latency numbers are ` +
      'machine-specific; relative comparisons are the point._',
  );
  lines.push('');

  const report = lines.join('\n');
  writeFileSync(reportPath, report + '\n', 'utf8');
  console.log(report);
}

// --- main ----------------------------------------------------------------------

/** One throwaway 1-token call so model-load time never lands in a cell. */
async function warmup(model: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        think: false,
        options: { num_predict: 1 },
      }),
    });
  } catch {
    /* best-effort */
  }
}

async function main(): Promise<void> {
  const checkpoint = loadCheckpoint();

  if (!reportOnly) {
    const totalCells = models.length * CONDITIONS.length * fixtures.length;
    let done = 0;
    for (const model of models) {
      const modelPending = CONDITIONS.some((condition) =>
        fixtures.some((f) => {
          const cell = checkpoint.generations[cellKey(model, condition, f.id)];
          return !cell || cell.error;
        }),
      );
      if (modelPending) await warmup(model);
      for (const condition of CONDITIONS) {
        for (const fixture of fixtures) {
          const key = cellKey(model, condition, fixture.id);
          done++;
          const existing = checkpoint.generations[key];
          if (existing && !existing.error) continue;
          process.stdout.write(`[${done}/${totalCells}] ${key} ... `);
          const record = await generate(model, condition, fixture);
          checkpoint.generations[key] = record;
          saveCheckpoint(checkpoint);
          console.log(
            record.error
              ? `ERROR ${record.error}`
              : `${Math.round(record.totalMs)}ms ttft=${fmtMs(record.ttftNetMs)}ms`,
          );
        }
      }
    }

    if (!skipJudge) {
      const pending = Object.values(checkpoint.generations).filter(
        (r) =>
          judgedOutput(r) !== null &&
          fixtures.some((f) => f.id === r.fixtureId) &&
          !checkpoint.judgements[cellKey(r.model, r.condition, r.fixtureId)]
            ?.score,
      );
      let judgedCount = 0;
      for (const record of pending) {
        const key = cellKey(record.model, record.condition, record.fixtureId);
        judgedCount++;
        process.stdout.write(
          `[judge ${judgedCount}/${pending.length}] ${key} ... `,
        );
        try {
          const score = await judge(
            fixtures.find((f) => f.id === record.fixtureId)!,
            judgedOutput(record)!,
          );
          checkpoint.judgements[key] = { key, score };
          console.log(
            `a=${score.adequacy} f=${score.fluency} l=${score.localization}`,
          );
        } catch (error) {
          checkpoint.judgements[key] = {
            key,
            error: error instanceof Error ? error.message : String(error),
          };
          console.log(`ERROR ${checkpoint.judgements[key].error}`);
        }
        saveCheckpoint(checkpoint);
      }
    }
  }

  writeReport(checkpoint);
}

void main();
