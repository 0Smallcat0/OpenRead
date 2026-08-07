/**
 * A user glossary: terms the translator must not touch, and terms it must
 * render one particular way.
 *
 * Every machine translator gets proper nouns wrong eventually. A product called
 * Sonnet becomes 十四行詩, a library called React becomes 反應, an author's name
 * is helpfully translated into its meaning. There is no prompt to fix this
 * with, because Chrome's built-in translator takes no prompt — it takes a
 * string and returns a string.
 *
 * So the term is hidden before the string goes in and put back after it comes
 * out. That only works if the placeholder survives the round trip intact, which
 * is a question about a model rather than about this code, so it was measured
 * rather than guessed. Eight placeholder shapes, four sentences each, against a
 * real Chrome, into nine target languages:
 *
 *   `⟦0⟧`   the obvious choice, and wrong: 6/6 into Chinese, Japanese, Korean,
 *           Spanish and German, then 0/4 into Arabic — the brackets are eaten
 *           and the bare digit is left standing in the sentence — 2/4 into
 *           Hindi, 1/4 into Thai.
 *   `#0#`   0/4 into Arabic, which respaces it to `# 0 #`.
 *   `%%0%%` 0/4 into Arabic, which translates the percent signs to `٪`.
 *   `〔0〕`  0/6 into Chinese, which translates the brackets to 「」.
 *   PUA     1/6 into Chinese. U+E000 is dropped outright.
 *   `OITT0Z` 1/4 — a letter run is a word, and words get changed: Hebrew
 *           returned `OITTT0Z`, Hindi `Oitt0z`.
 *
 * Three came through everywhere: `[[0]]`, `{0}` and `XX0XX`. `{0}` is a format
 * string and collides with the documentation this is most used on; `XX0XX` is
 * a letter run, which the Hebrew result above shows is not safe in general even
 * though this particular one held. `[[0]]` it is — punctuation-delimited, and
 * rare in rendered prose, where wiki bracket syntax has already become a link.
 */

/** One glossary line. */
export interface GlossaryEntry {
  /** The term as it appears in the source. Matched case-insensitively. */
  term: string;
  /**
   * What to put in the translation.
   *
   * Empty means the term itself: "do not translate this". A value means "and
   * always translate it *this* way" — the same mechanism, since a term that
   * survives untouched can be replaced with anything on the way back.
   */
  as: string;
}

/** A text with its terms hidden, and the values to put back. */
export interface ProtectedText {
  text: string;
  /** `values[i]` replaces the token numbered `indices[i]`. */
  values: string[];
  indices: number[];
}

/**
 * Most tokens one block will carry.
 *
 * A paragraph that is more placeholder than prose is one the translator has to
 * guess the shape of, and the protection stops paying for itself. Occurrences
 * past this are left alone — translated like any other word, which is the
 * behaviour without a glossary at all.
 */
export const MAX_TOKENS = 50;

/** Whitespace tolerated inside a token: Arabic respaced other shapes. */
const TOKEN_PATTERN = /\[\[\s*(\d+)\s*\]\]/g;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Parse the popup's textarea into entries.
 *
 * One per line. `term` on its own means leave it alone; `term = replacement`
 * means always render it that way. `#` starts a comment, blank lines are
 * ignored, and a line with an empty term is dropped rather than matching
 * everything.
 */
export function parseGlossary(raw: string | undefined | null): GlossaryEntry[] {
  // Tolerates a missing value rather than assuming the caller merged defaults.
  // The caller is the stream broker, and a `TypeError` there does not cost the
  // glossary — it costs every translation, on every page, with the reason
  // buried in a service worker nobody has open.
  if (!raw) return [];
  const entries: GlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    const term = (
      separator === -1 ? trimmed : trimmed.slice(0, separator)
    ).trim();
    const as = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    if (!term) continue;
    // A duplicate term would produce two rules for the same string, of which
    // only the first can ever fire. Keeping the first is what the reader of the
    // list expects; silently keeping the last is not.
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ term, as });
  }
  return entries;
}

/** Back to the textarea form, for a settings round trip. */
export function serializeGlossary(entries: readonly GlossaryEntry[]): string {
  return entries
    .map(({ term, as }) => (as ? `${term} = ${as}` : term))
    .join('\n');
}

/**
 * Whether a term needs word boundaries.
 *
 * Latin script does: a glossary entry for `AI` must not fire inside `said`.
 * Chinese, Japanese and Thai do not put spaces between words, so a boundary
 * assertion there would match nothing at all — 資料庫 has no word edge in
 * 建立資料庫時 and is still the term.
 */
const needsBoundary = (side: string): boolean => /[A-Za-z0-9]/.test(side);

function matcher(term: string): RegExp {
  const body = escapeRegExp(term);
  const before = needsBoundary(term[0] ?? '') ? '(?<![\\p{L}\\p{N}])' : '';
  const after = needsBoundary(term[term.length - 1] ?? '')
    ? '(?![\\p{L}\\p{N}])'
    : '';
  return new RegExp(`${before}${body}${after}`, 'giu');
}

/** The placeholder for one index. Exported so other protections agree on it. */
export function tokenFor(index: number): string {
  return `[[${String(index)}]]`;
}

/** Token numbers already present in the text, so ours never collide. */
export function takenIndices(text: string): Set<number> {
  const taken = new Set<number>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    taken.add(Number(match[1]));
  }
  return taken;
}

/**
 * Replace every glossary term with a placeholder.
 *
 * Longest term first, so an entry for `React Native` is not eaten by an entry
 * for `React`. Returns the text unchanged, with no values, when nothing
 * matched — the common case, and one that must cost nothing.
 */
export function protectTerms(
  text: string,
  entries: readonly GlossaryEntry[],
): ProtectedText {
  if (entries.length === 0) return { text, values: [], indices: [] };

  const taken = takenIndices(text);
  const values: string[] = [];
  const indices: number[] = [];
  let next = 0;
  const claim = (): number => {
    while (taken.has(next)) next++;
    taken.add(next);
    return next;
  };

  let out = text;
  const byLength = [...entries].sort((a, b) => b.term.length - a.term.length);
  for (const entry of byLength) {
    if (values.length >= MAX_TOKENS) break;
    out = out.replace(matcher(entry.term), (match) => {
      if (values.length >= MAX_TOKENS) return match;
      const index = claim();
      // An entry with no replacement keeps the glossary's own spelling rather
      // than the page's: a list that says `OpenRead` is a statement about how
      // the name is written, and a page that wrote `openread` was wrong.
      values.push(entry.as || entry.term);
      indices.push(index);
      return tokenFor(index);
    });
  }
  return { text: out, values, indices };
}

/**
 * Put the terms back.
 *
 * `complete` is false when a placeholder did not survive translation — dropped,
 * duplicated, or mangled past recognition. That is not a small cosmetic loss:
 * the term is missing from the sentence entirely, which is worse than having
 * been translated. The caller's answer is to translate again without
 * protection, so the reader gets a translated term instead of a hole.
 */
export function restoreTerms(
  text: string,
  hidden: ProtectedText,
): { text: string; complete: boolean } {
  if (hidden.values.length === 0) return { text, complete: true };

  const seen = new Map<number, number>();
  const out = text.replace(TOKEN_PATTERN, (match, digits: string) => {
    const index = Number(digits);
    const slot = hidden.indices.indexOf(index);
    if (slot === -1) return match;
    seen.set(index, (seen.get(index) ?? 0) + 1);
    return hidden.values[slot] ?? match;
  });
  const complete = hidden.indices.every((index) => seen.get(index) === 1);
  return { text: out, complete };
}

/** Whether a glossary would do anything to this text at all. */
export function hasGlossaryTerm(
  text: string,
  entries: readonly GlossaryEntry[],
): boolean {
  return entries.some((entry) => matcher(entry.term).test(text));
}
