/**
 * Simplified -> Traditional (Taiwan) conversion.
 *
 * This replaces v1's hand-rolled `zh-map.js` + `simplifiedToTraditional`, which
 * did unconditional single-character substitution and corrupted common words:
 *   界面 -> 界麵   公里 -> 公裡   台北 -> 臺北 (over-eager)
 *
 * OpenCC's `s2twp` profile converts at the phrase level with the Taiwan idiom
 * dictionary, so it fixes those cases (界面 -> 介面, 公里 stays 公里) and maps
 * mainland tech vocabulary to Taiwan usage (鼠标 -> 滑鼠, 软件 -> 軟體).
 */
import { Converter } from 'opencc-js';
import type { ChunkTransform } from './types';

// Building a Converter loads its dictionaries, so create it once, lazily.
type ConvertText = ReturnType<typeof Converter>;
let converter: ConvertText | null = null;

function getConverter(): ConvertText {
  converter ??= Converter({ from: 'cn', to: 'twp' });
  return converter;
}

/**
 * Convert Simplified Chinese to Traditional Chinese (Taiwan, phrase-level).
 * Text already Traditional passes through effectively unchanged. Empty input
 * is returned as-is.
 */
export function toTraditionalTW(text: string): string {
  if (!text) return text;
  return getConverter()(text);
}

/**
 * Longest source key in the dictionaries the `cn -> twp` chain consults —
 * STPhrases carries a 12-character idiom. Until that many characters have
 * arrived, a trailing run of phrase characters may still turn out to be the
 * opening of a longer entry. `zh-convert.test.ts` re-derives this number from
 * the installed dictionaries so a dependency bump cannot silently invalidate
 * it.
 */
export const MAX_PHRASE_LEN = 12;

/**
 * Characters that can occur inside a dictionary key. Keys never contain
 * whitespace — it separates key from value in the dictionary format — and,
 * besides `·` and `-`, no punctuation, so every other character is a boundary
 * no phrase can straddle. Surrogate halves count as phrase characters purely so
 * a cut never lands inside an astral character.
 */
const PHRASE_CHAR = /[0-9A-Za-z·㐀-䶿一-鿿\ud800-\udfff豈-﫿-]/;

/** Would splitting `pending` at `cut` change the conversion of the whole? */
function isSafeSplit(pending: string, cut: number, whole: string): boolean {
  const code = pending.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) return false; // mid astral character
  return (
    toTraditionalTW(pending.slice(0, cut)) +
      toTraditionalTW(pending.slice(cut)) ===
    whole
  );
}

/**
 * How much of `pending` can be converted and emitted without changing what the
 * conversion of the complete text would have been.
 */
function safeCut(pending: string): number {
  const len = pending.length;
  // Hold back the trailing run of phrase characters: any of them could still be
  // the opening of an entry whose remaining characters have not streamed in yet.
  let run = 0;
  while (
    run < len &&
    run < MAX_PHRASE_LEN - 1 &&
    PHRASE_CHAR.test(pending.charAt(len - 1 - run))
  ) {
    run++;
  }
  // That cap can still land inside an entry already complete in the buffer, so
  // walk back to the first position where splitting provably changes nothing.
  // Entries are at most MAX_PHRASE_LEN long, which bounds both the walk and the
  // held text at roughly twice that.
  const whole = toTraditionalTW(pending);
  let cut = len - run;
  while (cut > 0 && !isSafeSplit(pending, cut, whole)) cut--;
  return cut;
}

/**
 * Simplified -> Traditional (Taiwan) conversion for streamed text.
 *
 * `s2twp` maps whole phrases, so converting each streamed chunk on its own
 * silently mistranslates any phrase a chunk boundary happens to split:
 * `数据库` arriving as `数据` + `库` yields `數據庫` instead of `資料庫`, and
 * `下游` split in half yields `下遊`. This holds the ambiguous tail back until
 * enough context has arrived to convert it the same way a single call over the
 * whole text would — so the streamed result is byte-identical to
 * `toTraditionalTW` on the concatenated input.
 */
export class TraditionalTWTransform implements ChunkTransform {
  private held = '';

  push(chunk: string): string {
    if (!chunk) return '';
    const pending = this.held + chunk;
    const cut = safeCut(pending);
    this.held = pending.slice(cut);
    return cut === 0 ? '' : toTraditionalTW(pending.slice(0, cut));
  }

  end(): string {
    const rest = this.held;
    this.held = '';
    return rest ? toTraditionalTW(rest) : '';
  }
}
