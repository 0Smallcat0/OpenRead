/**
 * Script detection for the "same-language short-circuit" — deciding when a
 * selection needs no translation at all, so we can skip the API round-trip
 * entirely (zero latency, zero cost).
 *
 * Pure, dependency-free, and fully unit-tested. This is the fast path that
 * runs on every selection before any network work happens.
 */
import { SC_ONLY_CLASS, TC_ONLY_CLASS } from './zh-markers.generated';

export type ChineseScript = 'sc' | 'tc' | 'unknown';

/**
 * Characters that occur in exactly one Chinese script — presence of any is
 * strong evidence the text is in that script.
 *
 * Both sets are derived from the OpenCC dictionaries by
 * `scripts/gen-zh-markers.ts`, not hand-written. The hand-written lists this
 * replaced were wrong in both directions: characters Simplified merged into one
 * shared form (系 for 系/係/繫, 游 for 游/遊) were listed as Simplified-only
 * even though they are ordinary Traditional characters — so correct output such
 * as 系統 and 下游 scored as "Simplified leakage" in the eval and made
 * `shouldBypassAI` translate Traditional selections needlessly — while common
 * Simplified characters (发, 时, 们, 开, 软, 机) were missing outright, so
 * 计算机软件开发 was not detected as Simplified at all. Characters shared by
 * both scripts now fall out of both sets, which is the point.
 *
 * The `u` flag is required: the sets include astral-plane characters, and
 * without it their ranges would be read as surrogate halves.
 */
const SC_MARKERS = new RegExp(`[${SC_ONLY_CLASS}]`, 'u');
const TC_MARKERS = new RegExp(`[${TC_ONLY_CLASS}]`, 'u');

/**
 * Heuristic: is a Chinese string Simplified, Traditional, or indeterminate?
 * Only the first 100 chars are sampled — enough to catch a distinct marker
 * while staying O(1) on long selections.
 */
export function detectChineseScript(text: string): ChineseScript {
  const sample = text.slice(0, 100);
  if (SC_MARKERS.test(sample)) return 'sc';
  if (TC_MARKERS.test(sample)) return 'tc';
  return 'unknown';
}

/**
 * Does the text contain any Simplified-only character? Unlike
 * `detectChineseScript`, this scans the whole string (not just a sample) — the
 * eval harness uses it to detect residual Simplified "leakage" anywhere in a
 * translation that should be fully Traditional.
 */
export function hasSimplifiedChars(text: string): boolean {
  return SC_MARKERS.test(text);
}

export interface ScriptFlags {
  hasChinese: boolean;
  hasJapanese: boolean;
  hasKorean: boolean;
  /** Latin script with none of the CJK scripts present. */
  isLatin: boolean;
}

/** Lightweight per-script presence flags via Unicode-range probes. */
export function detectScripts(text: string): ScriptFlags {
  const hasChinese = /[一-龥]/.test(text);
  const hasJapanese = /[぀-ヿ]/.test(text);
  const hasKorean = /[가-힯]/.test(text);
  const isLatin =
    !hasChinese && !hasJapanese && !hasKorean && /[a-zA-Z]/.test(text);
  return { hasChinese, hasJapanese, hasKorean, isLatin };
}

/**
 * Decide whether we can skip the AI entirely because the source is already in
 * the target language/script. Deliberately conservative: when Simplified and
 * Traditional differ (e.g. SC source, TC target) we do NOT bypass — that case
 * still needs conversion.
 */
export function shouldBypassAI(text: string, targetLang: string): boolean {
  if (!text || !targetLang) return false;
  const sample = text.trim();
  if (!sample) return false;

  const { hasChinese, hasJapanese, hasKorean } = detectScripts(sample);
  const target = targetLang.toLowerCase();

  if (hasChinese) {
    const script = detectChineseScript(sample);
    if (
      target.includes('traditional') ||
      target.includes('taiwan') ||
      target.includes('繁體')
    ) {
      if (script === 'tc') return true;
    } else if (
      target.includes('simplified') ||
      target.includes('mandarin') ||
      target.includes('简体')
    ) {
      if (script === 'sc') return true;
    } else if (target === 'chinese') {
      // Ambiguous target — user signalled "I read Chinese"; show as-is.
      return true;
    }
  }

  if (target.includes('japanese') && hasJapanese) return true;
  if (target.includes('korean') && hasKorean) return true;

  return false;
}
