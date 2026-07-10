/**
 * Failure taxonomy for small-model structured-output replies.
 *
 * Classifies a raw enrichment reply into the shape it arrived in — the study's
 * unit of analysis. Categories are mutually exclusive and checked in priority
 * order; each maps to a recovery strategy (or the lack of one):
 *
 *   clean-json         parses as-is — nothing to recover.
 *   fenced-json        valid JSON inside a ``` fence — markdown habit.
 *   thinking-then-json valid JSON after visible chain-of-thought.
 *   json-with-prose    valid JSON wrapped in preamble/trailing prose.
 *   truncated-json     an object starts but never closes / cannot parse —
 *                      usually context or token-limit exhaustion.
 *   no-json            prose or a refusal with no object at all.
 *   empty              nothing usable was emitted.
 *
 * Pure and dependency-free so it is unit-testable and CI-safe.
 */

export type ReplyShape =
  | 'clean-json'
  | 'fenced-json'
  | 'thinking-then-json'
  | 'json-with-prose'
  | 'truncated-json'
  | 'no-json'
  | 'empty';

export const REPLY_SHAPES: readonly ReplyShape[] = [
  'clean-json',
  'fenced-json',
  'thinking-then-json',
  'json-with-prose',
  'truncated-json',
  'no-json',
  'empty',
];

function parsesAsObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    );
  } catch {
    return false;
  }
}

/** First `{` … last `}` span, the same recovery window the parser uses. */
function objectSpan(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function classifyReply(reply: string): ReplyShape {
  const trimmed = reply.trim();
  if (!trimmed) return 'empty';
  if (parsesAsObject(trimmed)) return 'clean-json';

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  if (fenced !== undefined && parsesAsObject(fenced.trim())) {
    return 'fenced-json';
  }

  const span = objectSpan(trimmed);
  if (span && parsesAsObject(span)) {
    const thinking = /^<think>/i.test(trimmed) || /<\/think>/i.test(trimmed);
    return thinking ? 'thinking-then-json' : 'json-with-prose';
  }

  if (trimmed.includes('{')) return 'truncated-json';
  return 'no-json';
}
