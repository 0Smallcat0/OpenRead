/**
 * Optional local enrichment — the light, best-effort structuring pass.
 *
 * When enabled, a small Ollama model is asked to label a capture with a title,
 * a one-sentence summary, and a few tags. Small models are unreliable at this
 * (Obsidian's own Web Clipper warns they "silently fail" once a page exceeds a
 * ~2048-token context), so this module is built around that reality: the prompt
 * truncates input to stay well inside context, and `parseEnrichResponse`
 * salvages whatever is usable from noisy output — fenced code blocks, preamble,
 * trailing prose, tags as a comma string — returning null rather than throwing
 * when nothing can be recovered. Enrichment is garnish; the raw capture is
 * always the source of truth.
 *
 * Pure and dependency-free, so the unit tests and the eval harness score the
 * exact parser the extension ships.
 */
import type { ChatMessage, EnrichResult } from './types';

/**
 * Max characters of source text sent to the model. Deliberately small: it keeps
 * the request well inside a weak model's context window so it does not silently
 * truncate and return irrelevant metadata.
 */
export const ENRICH_INPUT_LIMIT = 1200;

const MAX_TAGS = 6;
const MAX_TAG_LEN = 40;
const MAX_TITLE_LEN = 120;
const MAX_SUMMARY_LEN = 400;

/**
 * JSON schema for Ollama's constrained decoding (`format` parameter). The
 * structured-output study (`pnpm eval:structured`) measured this closing the
 * last unreliable tail — deepseek-r1 went 93.3% → 100% usable — at no latency
 * cost, so the client sends it on every enrichment request. The tolerant
 * parser below still runs afterwards: constrained decoding guarantees shape,
 * not content hygiene (length caps, tag normalisation, deduping).
 */
export const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'tags'],
} as const;

/**
 * Build the chat messages for an enrichment request. Title and summary are
 * requested in `targetLang` so the downstream metadata matches the reader's
 * language. Input is trimmed and truncated to `ENRICH_INPUT_LIMIT`.
 */
export function buildEnrichMessages(
  text: string,
  targetLang: string,
): ChatMessage[] {
  const clipped = text.trim().slice(0, ENRICH_INPUT_LIMIT);
  return [
    {
      role: 'system',
      content: [
        'You label a reading excerpt with metadata for a note-taking system.',
        `Reply with ONLY a compact JSON object, written in ${targetLang}:`,
        '{"title": string, "summary": string, "tags": string[]}',
        'Rules:',
        '1. title: at most 8 words, no surrounding quotes.',
        '2. summary: exactly one sentence.',
        '3. tags: 3 to 5 short lowercase keywords.',
        '4. No markdown, no code fences, no commentary — output JSON only.',
      ].join('\n'),
    },
    { role: 'user', content: clipped },
  ];
}

/** Slice out the first `{`…last `}` span — the JSON object, ignoring any prose
 * or code fence around it. Returns null when there is no object-shaped span. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Trim, strip wrapping quotes, collapse newlines, and cap length. */
function cleanScalar(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/** Normalise tags from an array (or a comma/、-separated string) into a deduped,
 * lowercased, length-capped list. Returns undefined when none survive. */
function cleanTags(value: unknown): string[] | undefined {
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') raw = value.split(/[,，、]/);
  else return undefined;

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item
      .trim()
      .replace(/^#/, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, MAX_TAG_LEN);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags.length ? tags : undefined;
}

/**
 * Parse a model's enrichment reply into whatever structured fields are usable.
 * Handles clean JSON, JSON wrapped in ```code fences```, and JSON buried in
 * preamble or trailing prose. Returns null when nothing usable can be
 * recovered, so callers fall back cleanly to a raw capture.
 */
export function parseEnrichResponse(content: string): EnrichResult | null {
  if (!content) return null;
  const candidate = extractJsonObject(content);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const result: EnrichResult = {};
  const title = cleanScalar(record.title, MAX_TITLE_LEN);
  const summary = cleanScalar(record.summary, MAX_SUMMARY_LEN);
  const tags = cleanTags(record.tags);
  if (title) result.title = title;
  if (summary) result.summary = summary;
  if (tags) result.tags = tags;

  return Object.keys(result).length > 0 ? result : null;
}
