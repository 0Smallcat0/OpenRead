/**
 * Where the CLI and the MCP server get their settings.
 *
 * The extension reads `chrome.storage`; nothing outside a browser can. So the
 * order here is flags, then environment, then the same defaults the extension
 * ships — which keeps `openread` usable with no arguments at all, the property
 * that makes `npx openread` a reasonable thing to type.
 */

export interface Config {
  baseUrl: string;
  model: string;
  targetLang: string;
}

/** Kept in step with `DEFAULT_SETTINGS` in `src/settings.ts` by a test. */
export const DEFAULTS: Config = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:latest',
  targetLang: 'Traditional Chinese',
};

export type Env = Record<string, string | undefined>;

/**
 * Resolve settings from flags over environment over defaults.
 *
 * `OLLAMA_HOST` is read because anyone running Ollama on another machine has
 * already set it for the `ollama` CLI, and asking them to set a second
 * variable that means the same thing is the kind of small tax this project
 * just spent a release removing.
 */
export function resolveConfig(
  flags: Partial<Config>,
  env: Env = process.env,
): Config {
  return {
    baseUrl:
      flags.baseUrl ??
      normaliseHost(env.OPENREAD_URL) ??
      normaliseHost(env.OLLAMA_HOST) ??
      DEFAULTS.baseUrl,
    model: flags.model ?? env.OPENREAD_MODEL ?? DEFAULTS.model,
    targetLang: flags.targetLang ?? env.OPENREAD_LANG ?? DEFAULTS.targetLang,
  };
}

/**
 * `OLLAMA_HOST` is conventionally bare — `127.0.0.1:11434`, or just a host —
 * so it needs a scheme before `new URL` will accept it.
 */
export function normaliseHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withScheme = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return undefined;
  }
}
