/**
 * Persisted user settings, stored in `chrome.storage.sync` so they follow the
 * user across machines. Three keys only: the local Ollama server URL, the model
 * name, and the target language (stored as the human-readable string the prompt
 * layer expects). No API key — inference is local.
 */

export interface Settings {
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
  baseUrl: 'http://localhost:11434',
  modelId: 'qwen2.5',
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
