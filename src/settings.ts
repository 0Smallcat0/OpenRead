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
  obsidianVault: '',
  obsidianFolder: 'OpenRead',
  enrichOnCapture: false,
};

/** Languages offered in the popup, in display order (first = default). */
export const TARGET_LANGUAGES = [
  'Traditional Chinese',
  'Simplified Chinese',
  'English',
  'Japanese',
  'Korean',
  'Spanish',
  'French',
  'German',
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

/** Persist a full settings object. */
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({
    ...settings,
    autoTranslateExcept: limitExcept(settings.autoTranslateExcept),
  });
}
