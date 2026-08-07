/**
 * Persisted user settings, stored in `chrome.storage.sync` so they follow the
 * user across machines: which engine translates, the Ollama server URL and
 * model for when that engine is Ollama, the target language (kept as the
 * human-readable string the prompt layer expects), and the capture options.
 * No API key — every engine runs on the user's own machine.
 */

/**
 * Which translator answers.
 *
 * `builtin` is Chrome's on-device translation model: nothing to install, a
 * language pack Chrome downloads itself on first use, and roughly 9-20 ms a
 * sentence. `ollama` is a local LLM, which costs a server and a multi-gigabyte
 * model and buys surrounding-page context, a choice of model, and the capture
 * enrichment pass.
 */
export type Engine = 'builtin' | 'ollama';

/**
 * Whether the original stays visible beside the translation.
 *
 * Bilingual is the default and the reason this project exists: a local model is
 * good, not perfect, and a reader has to be able to check a sentence that looks
 * wrong. But it doubles the length of the page, and a reader who trusts the
 * output on a long article would rather just read it.
 */
export type DisplayMode = 'bilingual' | 'translationOnly';

/** How an inserted translation is marked out from the text around it. */
export type TranslationStyle = 'line' | 'plain' | 'dashed' | 'highlight';

/** Size of the translation relative to the text it sits under. */
export type TranslationScale = 'small' | 'same' | 'large';

export type { HoverKey } from './ui/hover';
import type { HoverKey } from './ui/hover';

export type { AutoTranslate } from './core/auto-translate';
import type { AutoTranslate } from './core/auto-translate';

export interface Settings {
  engine: Engine;
  /** Base URL of the local Ollama server, e.g. http://localhost:11434. */
  baseUrl: string;
  modelId: string;
  targetLang: string;
  /** Translate a page on load without being asked. See `core/auto-translate`. */
  autoTranslate: AutoTranslate;
  /** Hosts never translated automatically. An entry covers its subdomains. */
  autoTranslateExcept: string[];
  /** Keep the original beside the translation, or show only the translation. */
  displayMode: DisplayMode;
  /** How the translation is marked out. See `ui/fullpage.ts` for the CSS. */
  translationStyle: TranslationStyle;
  translationScale: TranslationScale;
  /** Hold this key and point at a paragraph to translate that one. */
  hoverTranslate: HoverKey;
  /**
   * What a text box is translated *into*.
   *
   * Its own setting, because it is the other direction: `targetLang` is the
   * language you read in, and nobody writes a reply to an English forum in the
   * language they read English into.
   */
  inputTargetLang: string;
  /**
   * Terms the translator must leave alone, or must render one fixed way.
   *
   * Kept as the raw text of the popup's box rather than as parsed entries, so
   * a round trip through settings returns what the user typed — their
   * comments, their blank lines, their order. See `core/glossary.ts` for the
   * grammar and for why the placeholder looks the way it does.
   */
  glossary: string;
  /** Obsidian vault to capture into; empty = the user's current/last vault. */
  obsidianVault: string;
  /** Vault-relative folder for captures; empty = the vault root. */
  obsidianFolder: string;
  /** Run a local-model enrichment pass when capturing (best-effort, off by
   * default — small models are unreliable at structured extraction). */
  enrichOnCapture: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // Chrome's built-in translator by default, because it is the difference
  // between an extension that works when you install it and one that first
  // asks you to install a server and download five gigabytes.
  engine: 'builtin',
  baseUrl: 'http://localhost:11434',
  // Benchmark-driven default: best quality/latency of the models measured
  // in docs/BENCHMARK.md (chrF 46.3, TTFT-UI p50 451 ms on the test rig).
  modelId: 'qwen3:latest',
  targetLang: 'Traditional Chinese',
  // Off until asked for. An extension that starts rewriting pages the moment it
  // is installed is one the user did not consent to yet, whatever the setting
  // would have been worth to them afterwards.
  autoTranslate: 'off',
  autoTranslateExcept: [],
  // Bilingual, and the current look, so an upgrade changes nothing until it is
  // asked to.
  displayMode: 'bilingual',
  translationStyle: 'line',
  translationScale: 'same',
  // On, because it costs nothing until a key is held and it is the cheapest
  // thing here to discover by accident in the right way: a reader who holds Alt
  // over a paragraph gets exactly what they were about to select.
  hoverTranslate: 'alt',
  inputTargetLang: 'English',
  glossary: '',
  obsidianVault: '',
  obsidianFolder: 'OpenRead',
  enrichOnCapture: false,
};

/**
 * Languages offered in the popup, in display order (first = default).
 *
 * The four this shipped with, then the rest alphabetically. Every one of them
 * was probed against a real Chrome — see `core/bcp47.ts` for what was left out
 * and why.
 */
export const TARGET_LANGUAGES = [
  'Traditional Chinese',
  'Simplified Chinese',
  'English',
  'Japanese',
  'Korean',
  'Spanish',
  'French',
  'German',
  'Arabic',
  'Bengali',
  'Bulgarian',
  'Croatian',
  'Czech',
  'Danish',
  'Dutch',
  'Finnish',
  'Greek',
  'Hebrew',
  'Hindi',
  'Hungarian',
  'Indonesian',
  'Italian',
  'Kannada',
  'Lithuanian',
  'Marathi',
  'Norwegian',
  'Polish',
  'Portuguese',
  'Romanian',
  'Russian',
  'Slovak',
  'Slovenian',
  'Swedish',
  'Tamil',
  'Telugu',
  'Thai',
  'Turkish',
  'Ukrainian',
  'Vietnamese',
] as const;

/** Load settings, falling back to defaults for any unset key. */
export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get([
    'engine',
    'baseUrl',
    'modelId',
    'targetLang',
    'autoTranslate',
    'autoTranslateExcept',
    'displayMode',
    'translationStyle',
    'translationScale',
    'hoverTranslate',
    'inputTargetLang',
    'glossary',
    'obsidianVault',
    'obsidianFolder',
    'enrichOnCapture',
  ])) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Largest `autoTranslateExcept` we will try to store, in bytes of JSON.
 *
 * `chrome.storage.sync` rejects any single item over 8,192 bytes, and the
 * rejection is not confined to the offending key: `saveSettings` writes the
 * whole object in one call, so an over-long exception list means the target
 * language, the engine and everything else silently fail to save too.
 * Measured: 200 hosts of ordinary length throws
 * `Resource::kQuotaBytesPerItem quota exceeded`.
 *
 * 6 KB leaves room for the rest of the object and still holds well over a
 * hundred hostnames — far past what anyone excludes by hand.
 */
export const MAX_EXCEPT_BYTES = 6000;

/**
 * Trim the exception list to something storage will accept, newest kept.
 *
 * Dropping the oldest entries is a real loss and it is the lesser one: the
 * alternative is a write that rejects, taking every other setting with it.
 */
export function limitExcept(hosts: readonly string[]): string[] {
  const kept = [...hosts];
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_EXCEPT_BYTES) {
    kept.shift();
  }
  return kept;
}

/**
 * Largest glossary we will try to store, in bytes of JSON.
 *
 * Same 8,192-byte per-item ceiling as the exception list, and the same
 * all-or-nothing failure: a pasted terminology file would take the engine and
 * the target language down with it. 6 KB is several hundred terms.
 */
export const MAX_GLOSSARY_BYTES = 6000;

/**
 * Trim a glossary to something storage will accept, keeping the top.
 *
 * The opposite end from `limitExcept`, and deliberately: an exception list
 * grows by one host at a time as the user browses, so the newest entries are
 * the ones they just asked for, while a glossary is written top down and its
 * first lines are the ones that were worth writing first. Cut on a line
 * boundary — half a rule is a rule that fires on the wrong string.
 */
export function limitGlossary(raw: string): string {
  if (JSON.stringify(raw).length <= MAX_GLOSSARY_BYTES) return raw;
  const lines = raw.split(/\r?\n/);
  while (
    lines.length > 0 &&
    JSON.stringify(lines.join('\n')).length > MAX_GLOSSARY_BYTES
  ) {
    lines.pop();
  }
  return lines.join('\n');
}

/** Persist a full settings object. */
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({
    ...settings,
    autoTranslateExcept: limitExcept(settings.autoTranslateExcept),
    glossary: limitGlossary(settings.glossary),
  });
}
