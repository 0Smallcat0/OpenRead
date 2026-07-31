/**
 * Deterministic, network-free quality detectors used by the eval harness.
 * Each returns true when a specific defect is present in a translation, mostly
 * reusing the exact same core predicates the production pipeline uses — so the
 * eval measures the shipped behaviour, not a re-implementation of it.
 *
 * `hasControlTokenLeak` is the exception: it has no counterpart in `src/`
 * because the pipeline deliberately does not strip control tokens. See the
 * note on that function for the measurements behind that decision.
 */
import { isAIThinking } from '../src/core/sanitize';
import { hasSimplifiedChars } from '../src/core/language';

/** The output begins with model narration / preamble instead of a translation. */
export function hasPreamble(output: string): boolean {
  return isAIThinking(output);
}

/** The output contains Simplified-only characters (leakage for a TC target). */
export function hasSimplifiedLeak(output: string): boolean {
  return hasSimplifiedChars(output);
}

/** The output echoes the source verbatim as a leading prefix. */
export function hasEcho(source: string, output: string): boolean {
  const normalizedSource = source.trim().toLowerCase();
  if (!normalizedSource) return false;
  return output.trim().toLowerCase().startsWith(normalizedSource);
}

/**
 * Chat-template control tokens that are not natural language in any target.
 * The `/think` family needs a leading slash or an underscore to match, so an
 * ordinary sentence containing the English word "think" does not trip it.
 */
const CONTROL_TOKEN_PATTERN =
  /<\|im_(?:start|end)\|>|<\/?think>|(?:^|[\s(（])\/(?:no_)?think\b|\bno_think\b/i;

/**
 * The output contains a chat-template control token.
 *
 * Ollama's qwen3 template appends ` /no_think` to the *last user message* when
 * a request carries `think: false` — which every OpenRead translation does. The
 * extension sends no translation context, so that last message is the bare
 * source text and the token is glued directly onto the sentence the model is
 * asked to translate. Seen once in real use, rendered as content:
 * `Fetch 是基於 Promise 的，且位於 /no_think 路徑下。`
 *
 * The pipeline does not filter it, on the evidence: the token leaked 0 times in
 * 216 recorded benchmark generations and 0 times in 278 fresh ones swept over
 * temperature and selection length. Fencing the source in `<target>` tags to
 * move the token outside the translatable region was measured too and scored
 * chrF 46.39 against the shipped prompt's 46.76 — no gain, so it was not
 * shipped. A runtime filter would also have to hold an ambiguous tail across
 * chunk boundaries (`/no_` + `think`), which is real machinery to add for a
 * defect at this rate. This detector exists so the benchmark reports the rate
 * instead of anyone having to guess it again.
 */
export function hasControlTokenLeak(output: string): boolean {
  return CONTROL_TOKEN_PATTERN.test(output);
}
