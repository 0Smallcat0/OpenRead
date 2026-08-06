/**
 * Turning a connection probe into something a user can act on.
 *
 * Every new install has to clear the same two hurdles — Ollama running, and
 * Ollama willing to answer a browser extension — and until now the only place
 * either failure surfaced was inside a translation panel, after a selection,
 * phrased as an error. The popup is where the user is already configuring
 * things, so it is where the answer belongs.
 *
 * Pure on purpose: the probe does the I/O, this decides what it means. That
 * split is what lets every branch below be a test rather than a manual
 * reproduction of a misconfigured server.
 */

/** The subset of `chrome.runtime.getPlatformInfo()` os values we tailor for. */
export type PlatformOs = 'mac' | 'win' | 'linux' | 'other';

/** What a `/api/tags` probe found. */
export type ConnectionProbe =
  | { kind: 'ok'; models: string[] }
  /** 403 — the server is up but does not accept this extension's origin. */
  | { kind: 'forbidden' }
  /** The request never reached a server: not running, or wrong URL. */
  | { kind: 'unreachable' }
  | { kind: 'http'; status: number };

export interface ConnectionReport {
  tone: 'ok' | 'warn' | 'error';
  message: string;
  /** A command that fixes what `message` describes, ready to copy. */
  fix?: string;
}

/**
 * Ollama resolves a bare model name to its `:latest` tag, so a user who typed
 * `qwen3` is correctly configured even though `/api/tags` reports
 * `qwen3:latest`. Comparing the raw strings would warn about a working setup,
 * which is worse than not warning at all.
 */
export function modelIsInstalled(model: string, installed: string[]): boolean {
  const tagged = (name: string): string =>
    name.includes(':') ? name : `${name}:latest`;
  const wanted = tagged(model.trim());
  return installed.some((name) => tagged(name.trim()) === wanted);
}

/**
 * The command that adds this extension's origin to Ollama's allowlist.
 *
 * Ollama only answers requests whose `Origin` it was told about, and a browser
 * extension's origin (`chrome-extension://<id>`) is never on the default list.
 * The result is a 403 on every single request — the most common way a working
 * install looks broken.
 */
export function corsFixCommand(os: PlatformOs): string {
  switch (os) {
    case 'mac':
      return 'launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"';
    case 'win':
      return 'setx OLLAMA_ORIGINS "chrome-extension://*"';
    default:
      // Runnable as-is, unlike a systemd drop-in. Persisting it is the
      // README's job; unblocking the user right now is this string's job.
      return "OLLAMA_ORIGINS='chrome-extension://*' ollama serve";
  }
}

/**
 * The message for a translation that lost both engines.
 *
 * The built-in engine hands anything it structurally cannot do — an older
 * browser, Firefox, a language pair Chrome has no pack for — to Ollama rather
 * than failing, which is right: a user who has Ollama gets a translation
 * instead of an apology. What was wrong is what happened when that second
 * attempt also failed. The built-in reason was dropped on the floor and the
 * panel showed Ollama's message alone, so a Firefox user, or anyone on Chrome
 * 137, was told "Can't reach Ollama" — true, and about the wrong thing. They
 * had not chosen Ollama, did not have Ollama, and had no way to learn from that
 * sentence that their browser was the problem.
 *
 * Both reasons, first cause first. `builtinReason` is null when Ollama was the
 * engine the user actually picked, and then there is no first cause to report.
 */
export function describeEngineFailure(
  builtinReason: string | null,
  ollamaMessage: string,
): string {
  const first = builtinReason?.trim();
  if (!first) return ollamaMessage;
  // The reasons are sentences from `BuiltinUnavailableError`, but a caller
  // could hand over anything; joining without this produces "…translator
  // OpenRead fell back".
  const punctuated = /[.!?]$/.test(first) ? first : `${first}.`;
  return `${punctuated} OpenRead fell back to Ollama, which also failed: ${ollamaMessage}`;
}

export interface DescribeOptions {
  baseUrl: string;
  /** The model currently entered in the popup. */
  model: string;
  os: PlatformOs;
}

/** Render a probe as the line the popup shows, plus an optional fix command. */
export function describeConnection(
  probe: ConnectionProbe,
  { baseUrl, model, os }: DescribeOptions,
): ConnectionReport {
  switch (probe.kind) {
    case 'forbidden':
      return {
        tone: 'error',
        message:
          'Ollama is running but refused this extension (403). Add its ' +
          'origin to OLLAMA_ORIGINS, then restart Ollama.',
        fix: corsFixCommand(os),
      };

    case 'unreachable':
      return {
        tone: 'error',
        message: `Can't reach Ollama at ${baseUrl}. Is the server running?`,
        fix: 'ollama serve',
      };

    case 'http':
      return {
        tone: 'error',
        message: `Ollama answered ${String(probe.status)} at ${baseUrl}.`,
      };

    case 'ok': {
      if (probe.models.length === 0) {
        return {
          tone: 'warn',
          message: 'Connected, but no models are installed.',
          fix: 'ollama pull qwen3',
        };
      }
      const wanted = model.trim();
      if (wanted && !modelIsInstalled(wanted, probe.models)) {
        return {
          tone: 'warn',
          // Naming the model matters: the failure this prevents is a typo that
          // produces a 404 only once a translation is attempted.
          message: `Connected, but "${wanted}" is not installed.`,
          fix: `ollama pull ${wanted}`,
        };
      }
      const count = probe.models.length;
      return {
        tone: 'ok',
        message: `Connected — ${String(count)} model${count === 1 ? '' : 's'} available.`,
      };
    }
  }
}
