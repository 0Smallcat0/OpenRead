/**
 * The settings popup, as a mountable controller.
 *
 * Behaviour lives here rather than in the entrypoint so it can be driven in
 * jsdom against a stubbed probe — the same split the selection and capture UI
 * already use. The entrypoint is the four lines that supply the real
 * dependencies.
 *
 * What this adds beyond saving three strings: a first-run install has to clear
 * two hurdles (Ollama running, Ollama willing to answer an extension origin)
 * and a third that only bites later (a model name that is not installed).
 * Before this, all three surfaced the same way — a selection on a page,
 * followed by an error in a translation panel. The popup is where the user is
 * already looking, and it can reach the server on exactly the terms a
 * translation will.
 */
import {
  loadSettings,
  saveSettings,
  TARGET_LANGUAGES,
  DEFAULT_SETTINGS,
  type Settings,
} from '../settings';
import {
  describeConnection,
  type ConnectionProbe,
  type PlatformOs,
} from '../core/diagnostics';

export interface PopupDeps {
  probe: (baseUrl: string, signal?: AbortSignal) => Promise<ConnectionProbe>;
  /** Which OS to tailor the OLLAMA_ORIGINS fix command for. */
  platformOs: () => Promise<PlatformOs>;
  writeClipboard: (text: string) => Promise<void>;
  /** Ask the active tab to translate (or untranslate) itself. */
  translateActivePage: () => Promise<void>;
}

interface Elements {
  form: HTMLFormElement;
  baseUrl: HTMLInputElement;
  model: HTMLInputElement;
  modelOptions: HTMLDataListElement;
  lang: HTMLSelectElement;
  vault: HTMLInputElement;
  folder: HTMLInputElement;
  enrich: HTMLInputElement;
  status: HTMLElement;
  connection: HTMLElement;
  fix: HTMLElement;
  fixCommand: HTMLElement;
  copyFix: HTMLButtonElement;
  translatePage: HTMLButtonElement;
}

function collect(root: ParentNode): Elements | null {
  const form = root.querySelector<HTMLFormElement>('#settingsForm');
  const baseUrl = root.querySelector<HTMLInputElement>('#baseUrl');
  const model = root.querySelector<HTMLInputElement>('#modelId');
  const modelOptions = root.querySelector<HTMLDataListElement>('#modelOptions');
  const lang = root.querySelector<HTMLSelectElement>('#targetLang');
  const vault = root.querySelector<HTMLInputElement>('#obsidianVault');
  const folder = root.querySelector<HTMLInputElement>('#obsidianFolder');
  const enrich = root.querySelector<HTMLInputElement>('#enrichOnCapture');
  const status = root.querySelector<HTMLElement>('#status');
  const connection = root.querySelector<HTMLElement>('#connection');
  const fix = root.querySelector<HTMLElement>('#fix');
  const fixCommand = root.querySelector<HTMLElement>('#fixCommand');
  const copyFix = root.querySelector<HTMLButtonElement>('#copyFix');
  const translatePage = root.querySelector<HTMLButtonElement>('#translatePage');

  if (
    !form ||
    !baseUrl ||
    !model ||
    !modelOptions ||
    !lang ||
    !vault ||
    !folder ||
    !enrich ||
    !status ||
    !connection ||
    !fix ||
    !fixCommand ||
    !copyFix ||
    !translatePage
  ) {
    return null;
  }
  return {
    form,
    baseUrl,
    model,
    modelOptions,
    lang,
    vault,
    folder,
    enrich,
    status,
    connection,
    fix,
    fixCommand,
    copyFix,
    translatePage,
  };
}

/** Wire the popup up. Returns false when the document is not the popup. */
export function mountPopup(root: ParentNode, deps: PopupDeps): boolean {
  const el = collect(root);
  if (!el) return false;

  for (const language of TARGET_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language;
    option.textContent = language;
    el.lang.appendChild(option);
  }

  let os: PlatformOs = 'other';
  void deps.platformOs().then((value) => {
    os = value;
  });

  // The last probe, kept so retyping the model field can be re-judged without
  // another round trip to the server.
  let lastProbe: ConnectionProbe | null = null;
  // Monotonic: a probe that resolves after a newer one started is stale and
  // must not overwrite it. Typing a URL character by character is enough to
  // produce that ordering.
  let generation = 0;
  let inFlight: AbortController | null = null;

  // Arrow consts, not hoisted declarations: these close over the narrowed
  // `el`, and a hoisted `function` could in principle run before the null
  // guard above, which the compiler is right to refuse.
  const render = (): void => {
    if (!lastProbe) return;
    const report = describeConnection(lastProbe, {
      baseUrl: el.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
      model: el.model.value,
      os,
    });
    el.connection.textContent = report.message;
    el.connection.className = report.tone;

    if (report.fix) {
      el.fixCommand.textContent = report.fix;
      el.fix.removeAttribute('hidden');
    } else {
      el.fix.setAttribute('hidden', '');
    }
  };

  const check = (): void => {
    const mine = ++generation;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    el.connection.textContent = 'Checking…';
    el.connection.className = '';
    el.fix.setAttribute('hidden', '');

    const url = el.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl;
    void deps.probe(url, controller.signal).then((probe) => {
      if (mine !== generation) return;
      lastProbe = probe;

      // Offer what the server actually has. When it has nothing to offer the
      // list is emptied rather than left showing a previous server's models.
      el.modelOptions.replaceChildren();
      if (probe.kind === 'ok') {
        for (const name of probe.models) {
          const option = document.createElement('option');
          option.value = name;
          el.modelOptions.appendChild(option);
        }
      }
      render();
    });
  };

  void loadSettings().then((settings) => {
    el.baseUrl.value = settings.baseUrl;
    el.model.value = settings.modelId;
    el.lang.value = settings.targetLang;
    el.vault.value = settings.obsidianVault;
    el.folder.value = settings.obsidianFolder;
    el.enrich.checked = settings.enrichOnCapture;
    check();
  });

  el.baseUrl.addEventListener('change', check);
  // Re-judged locally: whether a model is installed is answered by the probe
  // already in hand, so retyping the field costs nothing.
  el.model.addEventListener('input', render);

  el.translatePage.addEventListener('click', () => {
    // Closing immediately is the honest signal that the work moved to the
    // page: the progress badge lives there, and a popup left open would
    // cover the corner it appears in.
    void deps.translateActivePage().finally(() => {
      window.close();
    });
  });

  el.copyFix.addEventListener('click', () => {
    const command = el.fixCommand.textContent ?? '';
    if (!command) return;
    void deps
      .writeClipboard(command)
      .then(() => {
        el.copyFix.textContent = 'Copied';
        window.setTimeout(() => {
          el.copyFix.textContent = 'Copy';
        }, 1500);
      })
      .catch(() => {
        el.copyFix.textContent = 'Copy failed';
      });
  });

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const settings: Settings = {
      baseUrl: el.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
      modelId: el.model.value.trim() || DEFAULT_SETTINGS.modelId,
      targetLang: el.lang.value,
      obsidianVault: el.vault.value.trim(),
      obsidianFolder: el.folder.value.trim() || DEFAULT_SETTINGS.obsidianFolder,
      enrichOnCapture: el.enrich.checked,
    };
    void saveSettings(settings)
      .then(() => {
        el.status.classList.remove('error');
        el.status.textContent = 'Saved ✓';
        window.setTimeout(() => {
          el.status.textContent = '';
        }, 1500);
      })
      .catch(() => {
        // Without this the failure is silent: the status line simply stays
        // blank, which reads exactly like "nothing happened yet".
        el.status.classList.add('error');
        el.status.textContent = 'Save failed';
      });
  });

  return true;
}
