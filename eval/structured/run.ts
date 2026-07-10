/**
 * Structured-output study — can schema-constrained decoding replace (or must
 * it complement) robust parsing for small-model enrichment?
 *
 * Conditions per model × input:
 *   prompt  — the shipped path: `buildEnrichMessages` prompt rules only
 *             (native `/api/chat`, `think: false`, temperature 0), the model
 *             free to misbehave.
 *   schema  — same request, decoding constrained to the EnrichResult JSON
 *             schema via the native `format` parameter.
 *
 * Each raw reply is then scored three ways at report time (no extra calls):
 *   naive parse   — strict JSON.parse of the whole reply.
 *   robust parse  — the shipped `parseEnrichResponse` salvage parser.
 *   field quality — title/summary/tags all present after cleaning.
 * plus a failure-shape taxonomy label (`taxonomy.ts`).
 *
 * Requires local Ollama; NOT in CI. Checkpoints after every cell:
 *   pnpm eval:structured [-- --models a,b] [--report-only]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  buildEnrichMessages,
  parseEnrichResponse,
  ENRICH_SCHEMA,
} from '../../src/core/enrich';
import { classifyReply, REPLY_SHAPES, type ReplyShape } from './taxonomy';

const TARGET_LANG = 'Traditional Chinese';
const SEED = 42;
const REQUEST_TIMEOUT_MS = 300_000;

const DEFAULT_MODELS = [
  'qwen3.5:latest',
  'qwen3:latest',
  'llama3.1:latest',
  'deepseek-r1:8b',
];

type GenCondition = 'prompt' | 'schema';
const GEN_CONDITIONS: GenCondition[] = ['prompt', 'schema'];

interface EnrichInput {
  id: string;
  url: string;
  pageTitle: string;
  lang: string;
  text: string;
}

interface CellRecord {
  model: string;
  condition: GenCondition;
  inputId: string;
  raw: string;
  totalMs: number;
  error?: string;
}

interface Checkpoint {
  meta: {
    baseUrl: string;
    targetLang: string;
    seed: number;
    startedAt: string;
  };
  cells: Record<string, CellRecord>;
}

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, '..', 'results');
const checkpointPath = join(resultsDir, 'structured-raw.json');
const reportPath = join(here, '..', 'STRUCTURED-RESULTS.md');

const baseUrl = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(
  /\/+$/,
  '',
);

function argList(flag: string): string[] | null {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) return null;
  return value.split(',').map((s) => s.trim());
}
const onlyModels = argList('--models');
const reportOnly = process.argv.includes('--report-only');

const inputs = JSON.parse(
  readFileSync(join(here, '..', 'dataset', 'enrich-inputs.json'), 'utf8'),
) as EnrichInput[];
const models = (onlyModels ?? DEFAULT_MODELS).slice();

const cellKey = (model: string, condition: string, inputId: string) =>
  `${model}|${condition}|${inputId}`;

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
  } catch {
    return {
      meta: {
        baseUrl,
        targetLang: TARGET_LANG,
        seed: SEED,
        startedAt: new Date().toISOString(),
      },
      cells: {},
    };
  }
}
function saveCheckpoint(checkpoint: Checkpoint): void {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 1), 'utf8');
}

// --- generation ---------------------------------------------------------------

async function generate(
  model: string,
  condition: GenCondition,
  input: EnrichInput,
): Promise<CellRecord> {
  const record: CellRecord = {
    model,
    condition,
    inputId: input.id,
    raw: '',
    totalMs: 0,
  };
  const body: Record<string, unknown> = {
    model,
    messages: buildEnrichMessages(input.text, TARGET_LANG),
    stream: false,
    think: false,
    options: { temperature: 0, seed: SEED },
  };
  if (condition === 'schema') body.format = ENRICH_SCHEMA;

  const t0 = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { message?: { content?: string } };
    record.raw = data.message?.content ?? '';
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }
  record.totalMs = performance.now() - t0;
  return record;
}

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

// --- scoring / report -----------------------------------------------------------

interface ParseOutcome {
  naive: boolean;
  robust: boolean;
  allFields: boolean;
  shape: ReplyShape;
}

function scoreReply(raw: string): ParseOutcome {
  let naive = false;
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    naive =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    naive = false;
  }
  const robustResult = parseEnrichResponse(raw);
  return {
    naive,
    robust: robustResult !== null,
    allFields: Boolean(
      robustResult?.title && robustResult.summary && robustResult.tags?.length,
    ),
    shape: classifyReply(raw),
  };
}

function pct(count: number, total: number): string {
  return total === 0 ? '—' : `${((count / total) * 100).toFixed(1)}%`;
}
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

function writeReport(checkpoint: Checkpoint): void {
  const lines: string[] = [];
  const all = Object.values(checkpoint.cells).filter((c) =>
    models.includes(c.model),
  );

  lines.push('# OpenRead — Structured-Output Study');
  lines.push('');
  lines.push(
    `Small-model enrichment replies over **${inputs.length}** realistic capture ` +
      `excerpts × **${models.length}** local models, generated once per condition ` +
      '(temperature 0, seed 42) and scored offline. `prompt` = the shipped ' +
      'prompt-rules-only path; `schema` = decoding constrained to the ' +
      'EnrichResult JSON schema. Regenerate with `pnpm eval:structured`.',
  );
  lines.push('');

  lines.push('## Headline — usable metadata rate by strategy');
  lines.push('');
  lines.push('| Generation | Parse | Usable rate | All 3 fields |');
  lines.push('| --- | --- | --- | --- |');
  for (const condition of GEN_CONDITIONS) {
    const ok = all.filter((c) => c.condition === condition && !c.error);
    const scores = ok.map((c) => scoreReply(c.raw));
    const naive = scores.filter((s) => s.naive).length;
    const robust = scores.filter((s) => s.robust).length;
    const fields = scores.filter((s) => s.allFields).length;
    lines.push(
      `| ${condition} | naive \`JSON.parse\` | ${pct(naive, scores.length)} | — |`,
    );
    lines.push(
      `| ${condition} | robust \`parseEnrichResponse\` | ${pct(robust, scores.length)} | ${pct(fields, scores.length)} |`,
    );
  }
  lines.push('');

  lines.push('## Per model');
  lines.push('');
  lines.push(
    '| Model | Gen | Naive parse | Robust parse | All fields | Median ms | Errors |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const model of models) {
    for (const condition of GEN_CONDITIONS) {
      const cells = all.filter(
        (c) => c.model === model && c.condition === condition,
      );
      if (cells.length === 0) continue;
      const ok = cells.filter((c) => !c.error);
      const scores = ok.map((c) => scoreReply(c.raw));
      const med = median(ok.map((c) => c.totalMs));
      lines.push(
        `| ${model} | ${condition} ` +
          `| ${pct(scores.filter((s) => s.naive).length, scores.length)} ` +
          `| ${pct(scores.filter((s) => s.robust).length, scores.length)} ` +
          `| ${pct(scores.filter((s) => s.allFields).length, scores.length)} ` +
          `| ${med === null ? '—' : Math.round(med)} ` +
          `| ${cells.length - ok.length}/${cells.length} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Failure shapes — unconstrained (`prompt`) replies');
  lines.push('');
  lines.push(`| Model | ${REPLY_SHAPES.join(' | ')} |`);
  lines.push(`| --- |${' --- |'.repeat(REPLY_SHAPES.length)}`);
  for (const model of models) {
    const ok = all.filter(
      (c) => c.model === model && c.condition === 'prompt' && !c.error,
    );
    const counts = new Map<ReplyShape, number>();
    for (const c of ok) {
      const shape = classifyReply(c.raw);
      counts.set(shape, (counts.get(shape) ?? 0) + 1);
    }
    lines.push(
      `| ${model} | ${REPLY_SHAPES.map((s) => counts.get(s) ?? 0).join(' | ')} |`,
    );
  }
  lines.push('');

  lines.push(
    '_Both conditions run on the native `/api/chat` endpoint with `think: false` ' +
      '(the shipped client path); `schema` adds the `format` parameter. Latency ' +
      'medians include any hidden reasoning time._',
  );
  lines.push('');

  const report = lines.join('\n');
  writeFileSync(reportPath, report + '\n', 'utf8');
  console.log(report);
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  const checkpoint = loadCheckpoint();

  if (!reportOnly) {
    const total = models.length * GEN_CONDITIONS.length * inputs.length;
    let done = 0;
    for (const model of models) {
      const pending = GEN_CONDITIONS.some((condition) =>
        inputs.some((input) => {
          const cell = checkpoint.cells[cellKey(model, condition, input.id)];
          return !cell || cell.error;
        }),
      );
      if (pending) await warmup(model);
      for (const condition of GEN_CONDITIONS) {
        for (const input of inputs) {
          const key = cellKey(model, condition, input.id);
          done++;
          const existing = checkpoint.cells[key];
          if (existing && !existing.error) continue;
          process.stdout.write(`[${done}/${total}] ${key} ... `);
          const record = await generate(model, condition, input);
          checkpoint.cells[key] = record;
          saveCheckpoint(checkpoint);
          console.log(
            record.error
              ? `ERROR ${record.error}`
              : `${Math.round(record.totalMs)}ms ${classifyReply(record.raw)}`,
          );
        }
      }
    }
  }

  writeReport(checkpoint);
}

void main();
