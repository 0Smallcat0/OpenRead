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
