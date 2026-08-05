/**
 * Taiwan vocabulary for text that is already in Traditional characters.
 *
 * Chrome's built-in translator targets `zh-Hant`, and it does write Traditional
 * characters — but it writes them with mainland word choices. Measured over one
 * translated Wikipedia article (44 blocks, 4,734 characters): 12 × 本地,
 * 10 × 運行, 4 × 代碼, 3 × 用戶, 2 × 項目, 1 × 配置. Thirty-two substitutions a
 * Taiwanese reader would notice immediately.
 *
 * OpenCC cannot fix this. `s2twp` keys its phrase tables on *Simplified*
 * forms, so text that is already Traditional never matches, and the
 * Traditional→Simplified→Traditional round trip that would make it match is
 * lossy — 髮 and 發 both collapse to 发 on the way down.
 *
 * So: a small, explicit table, applied only where it belongs. This corrects a
 * claim this project published and had to retract in 2.7.1 — that the built-in
 * engine produced Taiwan conventions natively. It produces some of them.
 */

/**
 * Mainland term → Taiwan term, both in Traditional characters.
 *
 * Deliberately short and technical. This is not a general-purpose localiser:
 * every entry is a word that appears in software and documentation text, where
 * the two conventions genuinely differ and the Taiwan form is unambiguous.
 * Ordinary prose is left alone, because a translator that quietly rewrites
 * word choices it merely dislikes is worse than one that does nothing.
 */
const REPLACEMENTS: [RegExp, string][] = [
  // Two words carry an exception, expressed as a lookahead rather than an
  // identity rule: 本地化 is *localisation* and is correct Taiwan usage, and
  // 用戶端 is the ordinary Taiwan word for a client. Only the bare forms move.
  // Before the bare rule, or "本地機器" becomes the stutter "本機機器".
  [/本地機器/g, '本機'],
  [/本地(?!化)/g, '本機'],
  [/用戶(?!端)/g, '使用者'],

  [/運行/g, '執行'],
  [/代碼/g, '程式碼'],
  [/源碼/g, '原始碼'],
  [/項目/g, '專案'],
  [/配置/g, '設定'],
  [/軟件/g, '軟體'],
  [/硬件/g, '硬體'],
  [/界面/g, '介面'],
  [/視頻/g, '影片'],
  [/網絡/g, '網路'],
  [/服務器/g, '伺服器'],
  [/內存/g, '記憶體'],
  [/默認/g, '預設'],
  [/優先級/g, '優先順序'],
  [/集成/g, '整合'],
  [/兼容/g, '相容'],
  [/緩存/g, '快取'],
  [/線程/g, '執行緒'],
  [/進程/g, '行程'],
  [/端口/g, '連接埠'],
  [/字符串/g, '字串'],
  [/數組/g, '陣列'],
  [/函數/g, '函式'],
  [/對象/g, '物件'],
  [/屏幕/g, '螢幕'],
  [/鼠標/g, '滑鼠'],
  [/文件夾/g, '資料夾'],
  [/回車/g, '換行'],
  [/操作系統/g, '作業系統'],
  [/文檔/g, '文件'],
  [/穩定釋放/g, '穩定版本'],
];

/**
 * Rewrite mainland technical vocabulary into Taiwan usage.
 *
 * Safe to call on text that needs nothing: every pattern is a whole word that
 * either appears or does not. Not safe to call on Simplified input — that is
 * OpenCC's job, and doing both would be two transforms fighting over the same
 * string.
 */
export function toTaiwanVocabulary(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Whether a target language wants this pass at all. */
export function wantsTaiwanVocabulary(targetLang: string): boolean {
  return (
    targetLang.includes('Traditional') ||
    targetLang.includes('繁體') ||
    targetLang.includes('Taiwan') ||
    /^zh-(Hant|TW)/i.test(targetLang.trim())
  );
}
