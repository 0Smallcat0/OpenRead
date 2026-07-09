/**
 * Output sanitizer — the "reliability layer" that turns raw model output into
 * a clean translation.
 *
 * LLMs asked to translate frequently emit non-translation noise: a preamble
 * ("Sure, here is the translation:"), visible chain-of-thought ("The user
 * wants..."), the input echoed back, or the whole thing wrapped in quotes.
 * These functions strip that noise. They are pure and fully unit-tested, and
 * the pattern list is exported so the eval harness can measure preamble
 * leakage on real model output.
 */

/**
 * Prefixes that signal the model is narrating instead of translating. Anchored
 * to the start (`^`) because a legitimate translation may contain these words
 * mid-sentence — only a leading occurrence is noise. Covers English and the
 * Traditional/Simplified Chinese variants seen in v1 traffic.
 */
export const AI_PREAMBLE_PATTERNS: readonly RegExp[] = [
  /^<think>/i,
  /^The user (wants|is asking)/i,
  /^Let me (analyze|translate|break down)/i,
  /^(Sure|Okay|OK)[,!]? (I can|here|let)/i,
  /^Here (is|are) (the|your)/i,
  /^(Translation|Answer|Analysis|Output|Result)\s*[:：]/i,
  /^Step 1[:：]/i,
  /^I will\b/i,
  /^好的[，,]?/,
  /^這段(文字|話)/,
  /^我(會|將)(將|把|其)?/,
  /^讓我(逐句|分析|翻譯)/,
  /^首先[，,]/,
];

/** Does `text` begin like model narration rather than a translation? */
export function isAIThinking(text: string): boolean {
  const trimmed = text.trim();
  return AI_PREAMBLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Strip a symmetric wrapping pair of straight/quote characters, if present. */
function stripWrappingQuotes(text: string): string {
  const pairs: ReadonlyArray<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['「', '」'],
    ['“', '”'],
  ];
  for (const [open, close] of pairs) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

/**
 * Remove model artifacts from a chunk of output.
 *
 * When `isStart` is true (the first chunk of a stream, or a whole non-streamed
 * response) the aggressive preamble filter runs: if the text opens with a known
 * narration prefix we prefer the content after the first blank line (the model
 * usually separates its thought from the result with `\n\n`), falling back to
 * stripping the matched prefix inline. Quote-unwrapping runs on every chunk.
 */
export function cleanAIArtifacts(text: string, isStart = false): string {
  let clean = text;

  if (isStart) {
    const matched = AI_PREAMBLE_PATTERNS.find((p) => p.test(clean.trim()));
    if (matched) {
      const paragraphs = clean.split(/\n\n+/);
      const firstNewline = clean.indexOf('\n');
      const firstLine =
        firstNewline >= 0 ? clean.slice(0, firstNewline) : clean;
      const colon = firstLine.search(/[:：]/);

      if (paragraphs.length > 1) {
        // Model separated its thought from the result with a blank line.
        clean = paragraphs.slice(1).join('\n\n').trim();
      } else if (colon >= 0) {
        // "Here is the translation: <result>" — keep everything after the colon
        // (covers the result being on the same line or a following one).
        clean = clean.slice(colon + 1).trim();
      } else if (firstNewline >= 0) {
        // The whole opening line was preamble; keep the lines after it.
        clean = clean.slice(firstNewline + 1).trim();
      } else {
        // Single bare line with no delimiter — strip just the matched prefix.
        clean = clean.replace(matched, '').trim();
      }
    }
  }

  return stripWrappingQuotes(clean.trim());
}

/**
 * Remove the input echo: some models restate the source before (or instead of)
 * translating it. If the output begins with the input verbatim (case-folded),
 * drop that prefix. Returns the remainder trimmed.
 */
export function stripEcho(input: string, output: string): string {
  const trimmedInput = input.trim();
  if (!trimmedInput) return output.trim();
  if (output.trim().toLowerCase().startsWith(trimmedInput.toLowerCase())) {
    return output.trim().slice(trimmedInput.length).trim();
  }
  return output.trim();
}

/**
 * Full cleanup for a completed (non-streamed) translation: strip preamble and
 * wrapping quotes, then remove any echo of the input. `input` may be null when
 * the source is unknown (e.g. batch mode), in which case echo removal is skipped.
 */
export function cleanTranslationOutput(
  input: string | null,
  output: string,
): string {
  const deArtifacted = cleanAIArtifacts(output.trim(), true);
  return input ? stripEcho(input, deArtifacted) : deArtifacted;
}
