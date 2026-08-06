/**
 * Mapping the popup's language names onto the codes Chrome's built-in
 * translator speaks.
 *
 * The rest of this project passes target languages around as human-readable
 * strings ("Traditional Chinese"), because that is what goes into an LLM
 * prompt and what a user reads in a dropdown. Chrome's `Translator` API takes
 * BCP-47, and it distinguishes `zh-Hant` from `zh` — which is the whole
 * ballgame here, since sending `zh` to a Taiwanese reader produces exactly the
 * Simplified-flavoured output this project exists to avoid.
 *
 * Pure and separate so the mapping is a test rather than a string literal
 * buried in a call site.
 */

/**
 * Popup language name -> BCP-47 code Chrome's Translator accepts.
 *
 * Every entry here was measured against a real Chrome rather than taken from
 * documentation: `Translator.availability({ sourceLanguage: 'en',
 * targetLanguage: code })` answered `available` or `downloadable` for all of
 * them. Twelve plausible candidates answered `unavailable` and are deliberately
 * absent — Malay, Persian, Latvian, Estonian, Serbian, Catalan, Urdu, Swahili,
 * Filipino, Gujarati and Malayalam among them — because offering a language the
 * engine will refuse is worse than not offering it.
 */
const BY_NAME: Record<string, string> = {
  'Traditional Chinese': 'zh-Hant',
  'Simplified Chinese': 'zh',
  English: 'en',
  Japanese: 'ja',
  Korean: 'ko',
  Spanish: 'es',
  French: 'fr',
  German: 'de',
  Arabic: 'ar',
  Bengali: 'bn',
  Bulgarian: 'bg',
  Croatian: 'hr',
  Czech: 'cs',
  Danish: 'da',
  Dutch: 'nl',
  Finnish: 'fi',
  Greek: 'el',
  Hebrew: 'he',
  Hindi: 'hi',
  Hungarian: 'hu',
  Indonesian: 'id',
  Italian: 'it',
  Kannada: 'kn',
  Lithuanian: 'lt',
  Marathi: 'mr',
  Norwegian: 'no',
  Polish: 'pl',
  Portuguese: 'pt',
  Romanian: 'ro',
  Russian: 'ru',
  Slovak: 'sk',
  Slovenian: 'sl',
  Swedish: 'sv',
  Tamil: 'ta',
  Telugu: 'te',
  Thai: 'th',
  Turkish: 'tr',
  Ukrainian: 'uk',
  Vietnamese: 'vi',
};

/**
 * Resolve a target language to BCP-47, or null when it is not one this table
 * knows.
 *
 * Null is a real answer, not a failure to handle: a language the built-in
 * translator has no code for is one the Ollama path must take instead, and
 * silently guessing `en` would translate into the wrong language rather than
 * declining to.
 */
export function toBcp47(targetLang: string): string | null {
  const exact = BY_NAME[targetLang.trim()];
  if (exact) return exact;

  // Tolerate a code that is already BCP-47, so a value that arrived from
  // somewhere other than the dropdown still works.
  const trimmed = targetLang.trim();
  if (/^[a-z]{2,3}(-[A-Za-z]{2,8})*$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Whether the built-in translator can be asked for this language at all.
 * Availability of the actual language pack is a separate, runtime question.
 */
export function isBuiltinTarget(targetLang: string): boolean {
  return toBcp47(targetLang) !== null;
}
