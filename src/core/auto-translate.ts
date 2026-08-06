/**
 * Deciding, without being asked, whether to translate a page.
 *
 * The feature everyone means when they say a translator is "automatic", and the
 * one with the worst failure mode in the product: translating a page the reader
 * can already read. That is not a slow feature or a missing one — it is the
 * extension actively damaging a page nobody asked it to touch, on every load,
 * until they find the setting.
 *
 * So the bias here is asymmetric on purpose. When the page does not say what
 * language it is in, the answer is no. A missed auto-translation costs one
 * keypress; an unwanted one costs trust.
 *
 * Pure and DOM-free, so every branch below is a test rather than a page someone
 * has to go and find.
 */
import { toBcp47 } from './bcp47';
import { shouldBypassAI } from './language';

/**
 * When to translate without being asked.
 *
 * `foreign` is the useful one and the default anyone would want; `always` earns
 * its place for a reader whose target language is not what any page declares —
 * and for the case where a site lies in its `lang` attribute, which is common
 * enough on templated sites to be worth an escape hatch.
 */
export type AutoTranslate = 'off' | 'foreign' | 'always';

export interface AutoTranslateContext {
  mode: AutoTranslate;
  /** `location.hostname` of the page asking. */
  host: string;
  /** Hosts the user has said never to do this on. */
  except: string[];
  /** The document's declared language: `<html lang>`, or null when absent. */
  pageLang: string | null;
  /** A short sample of the page's own text, for when `lang` is ambiguous. */
  sample: string;
  targetLang: string;
}

/** The primary subtag, lowercased: `zh-Hant-TW` -> `zh`. */
function primary(tag: string): string {
  return tag.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * Which Chinese script a tag means, or null when it does not say.
 *
 * Region implies script where the tag omits it, which is how the web actually
 * writes this: `zh-TW` vastly outnumbers `zh-Hant-TW`.
 */
function chineseScript(tag: string): 'hant' | 'hans' | null {
  const parts = tag.trim().toLowerCase().split('-');
  if (parts.includes('hant')) return 'hant';
  if (parts.includes('hans')) return 'hans';
  if (parts.some((part) => part === 'tw' || part === 'hk' || part === 'mo')) {
    return 'hant';
  }
  if (parts.some((part) => part === 'cn' || part === 'sg')) return 'hans';
  return null;
}

export type LanguageMatch = 'same' | 'different' | 'unknown';

/**
 * Is a page's declared language the one the reader wants?
 *
 * `unknown` is a real answer and the interesting one: a page that declares bare
 * `zh` has said "Chinese" and nothing about which script, and both scripts are
 * common under that tag. The caller resolves those from the text itself, where
 * this project already has a good detector.
 */
export function compareLanguage(
  pageLang: string,
  targetLang: string,
): LanguageMatch {
  const target = toBcp47(targetLang);
  if (!target) return 'unknown';
  const page = primary(pageLang);
  if (!page) return 'unknown';
  if (page !== primary(target)) return 'different';
  if (page !== 'zh') return 'same';

  const pageScript = chineseScript(pageLang);
  // Our own table maps "Simplified Chinese" to bare `zh`, following what
  // Chrome's Translator expects, so an unmarked target here is Simplified. An
  // unmarked *page* is genuinely ambiguous and stays that way.
  const targetScript = chineseScript(target) ?? 'hans';
  if (!pageScript) return 'unknown';
  return pageScript === targetScript ? 'same' : 'different';
}

/**
 * Has the user excluded this host?
 *
 * A stored entry covers its subdomains, and `www.` is ignored on both sides,
 * because "never on this site" is what the checkbox says and nobody means
 * "never on the exact hostname I happened to be on".
 */
export function isExcepted(host: string, except: readonly string[]): boolean {
  const bare = (value: string): string =>
    value.trim().toLowerCase().replace(/^www\./, '');
  const target = bare(host);
  if (!target) return false;
  return except.some((entry) => {
    const listed = bare(entry);
    return listed !== '' && (target === listed || target.endsWith(`.${listed}`));
  });
}

/** Should this page translate itself, right now, without being asked? */
export function shouldAutoTranslate(context: AutoTranslateContext): boolean {
  if (context.mode === 'off') return false;
  if (isExcepted(context.host, context.except)) return false;
  if (context.mode === 'always') return true;

  const declared = context.pageLang?.trim();
  // Nothing declared. Reading the text would mean guessing which of several
  // Latin-script languages it is, which is exactly the guess that ends with an
  // English page translated into English on every load. Almost every real site
  // sets `lang`; the ones that do not can still be translated by pressing the
  // button.
  if (!declared) return false;

  switch (compareLanguage(declared, context.targetLang)) {
    case 'different':
      return true;
    case 'same':
      return false;
    default:
      // Ambiguous `zh`. The script detector reads the text itself, and it is
      // the same check that decides whether a selection needs translating.
      return !shouldBypassAI(context.sample, context.targetLang);
  }
}
