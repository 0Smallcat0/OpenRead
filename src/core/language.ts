/**
 * Script detection for the "same-language short-circuit" — deciding when a
 * selection needs no translation at all, so we can skip the API round-trip
 * entirely (zero latency, zero cost).
 *
 * Pure, dependency-free, and fully unit-tested. This is the fast path that
 * runs on every selection before any network work happens.
 */

export type ChineseScript = 'sc' | 'tc' | 'unknown';

/**
 * Characters that only exist in Simplified Chinese (their Traditional form
 * differs). Presence of any is strong evidence the text is Simplified.
 */
const SC_MARKERS =
  /[爱罢备笔毕边参仓产长尝车齿虫刍从窜达带单当导灯点东斗独顿夺堕儿尔尧乐厉虑乱马买卖门亩内宁农呕盘赔鹏骗贫扑热认荣肉闰润洒伞丧扫杀晒闪伤舍摄声胜师湿实势视适书术树帅苏岁孙条铁听厅图团椭洼袜网卫稳务雾袭习系戏虾吓献乡响协写谢兴绣须虚轩悬选学压亚严岩颜阎艳厌燕扬阳杨瑶业叶仪艺亿忆义隐阴瘾樱婴鹰应莹颖哟拥优邮犹游鱼娱誉预园员圆缘远愿约岳云运韵杂灾暂脏凿责择则泽贼赠轧闸诈斋债毡盏斩战栈帐胀赵这诊镇阵争执职纸质钟终种肿众昼猪诸诛烛砖转赚庄装壮状锥赘坠准资兹总纵邹钻嘴罪遵]/;

/**
 * Characters that only exist in Traditional Chinese. Mirror of SC_MARKERS.
 */
const TC_MARKERS =
  /[愛罷備筆畢邊參倉產長嘗車齒蟲芻從竄達帶單當導燈點東鬥獨頓奪墮兒爾堯樂厲慮亂馬買賣門畝內寧農嘔盤賠鵬騙貧撲熱認榮閏潤灑傘喪掃殺曬閃傷捨攝聲勝師濕實勢視適書術樹帥蘇歲孫條鐵聽廳圖團橢窪襪網衛穩務霧襲習係戲蝦嚇獻鄉響協寫謝興繡須虛軒懸選學壓亞嚴顏閻艷厭燕揚陽楊瑤業葉儀藝億憶義隱陰癮櫻嬰鷹應瑩穎喲擁優郵猶遊魚娛譽預園員圓緣遠願約岳雲運韻雜災暫臟鑿責擇則澤賊贈軋閘詐齋債氈盞斬戰棧帳脹趙這診鎮陣爭執紙質鐘終種腫眾晝豬諸誅燭磚轉賺莊裝壯狀錐贅墜準資茲總縱鄒鑽嘴罪遵]/;

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
