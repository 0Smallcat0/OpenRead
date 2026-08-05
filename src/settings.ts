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

export interface Settings {
  engine: Engine;
  /** Base URL of the local Ollama server, e.g. http://localhost:11434. */
  baseUrl: string;
  modelId: string;
  targetLang: string;
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
    'obsidianVault',
    'obsidianFolder',
    'enrichOnCapture',
  ])) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Persist a full settings object. */
export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set(settings);
}
