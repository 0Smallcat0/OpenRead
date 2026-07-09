/**
 * LLM-as-judge quality scorer — the live, opt-in half of the eval harness.
 *
 * The offline runner (`run.ts`) measures mechanical defects deterministically.
 * This complements it with a subjective quality signal: for each fixture it
 * asks a judge model to rate the reliability-layer output on adequacy and
 * fluency (1–5), then reports the averages. It talks to a local Ollama server,
 * so it is NOT wired into CI — run it manually once Ollama is up:
 *
 *   OLLAMA_URL=http://localhost:11434 pnpm tsx eval/judge.ts [judgeModel]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanTranslationOutput } from '../src/core/sanitize';
import { toTraditionalTW } from '../src/core/zh-convert';

interface Fixture {
  id: string;
  source: string;
  targetLang: string;
  rawOutput: string;
}

interface Score {
  adequacy: number;
  fluency: number;
}

const baseUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
const judgeModel = process.argv[2] ?? 'qwen2.5';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, 'dataset', 'fixtures.json'), 'utf8'),
) as Fixture[];

function wantsTraditional(targetLang: string): boolean {
  return targetLang.includes('Traditional') || targetLang.includes('繁體');
}

function applyReliabilityLayer(fixture: Fixture): string {
  const cleaned = cleanTranslationOutput(fixture.source, fixture.rawOutput);
  return wantsTraditional(fixture.targetLang)
    ? toTraditionalTW(cleaned)
    : cleaned;
}

async function grade(
  fixture: Fixture,
  translation: string,
): Promise<Score | null> {
  const prompt =
    `You are grading a translation into ${fixture.targetLang}.\n` +
    `Source: ${fixture.source}\nTranslation: ${translation}\n\n` +
    'Rate adequacy (meaning preserved) and fluency (natural target language) ' +
    'from 1 to 5. Reply ONLY as JSON: {"adequacy":N,"fluency":N}.';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: judgeModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const match = content.match(/\{[^}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Score;
    return {
      adequacy: Number(parsed.adequacy),
      fluency: Number(parsed.fluency),
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const scores: Score[] = [];
  for (const fixture of fixtures) {
    const translation = applyReliabilityLayer(fixture);
    const score = await grade(fixture, translation);
    if (score) {
      scores.push(score);
      console.log(
        `${fixture.id}: adequacy=${score.adequacy} fluency=${score.fluency}`,
      );
    } else {
      console.log(`${fixture.id}: (ungraded)`);
    }
  }

  if (scores.length === 0) {
    console.log(
      'No fixtures were graded. Is Ollama running at ' + baseUrl + '?',
    );
    return;
  }
  const avg = (key: keyof Score) =>
    (scores.reduce((sum, s) => sum + s[key], 0) / scores.length).toFixed(2);
  console.log(
    `\nJudge model: ${judgeModel}\n` +
      `Graded ${scores.length}/${fixtures.length} — ` +
      `avg adequacy ${avg('adequacy')}/5, avg fluency ${avg('fluency')}/5`,
  );
}

void main();
