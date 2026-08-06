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
  type Engine,
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
  engine: HTMLSelectElement;
  engineNote: HTMLElement;
  ollamaOnly: HTMLElement;
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
  const engine = root.querySelector<HTMLSelectElement>('#engine');
  const engineNote = root.querySelector<HTMLElement>('#engineNote');
  const ollamaOnly = root.querySelector<HTMLElement>('#ollamaOnly');
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
    !engine ||
    !engineNote ||
    !ollamaOnly ||
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
    engine,
    engineNote,
    ollamaOnly,
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

  const ENGINE_NOTES: Record<Engine, string> = {
    builtin:
      "Chrome's own on-device translator. Nothing to install — Chrome " +
      'downloads the language pack the first time you use it. Fast, and it ' +
      'never leaves your machine.',
    ollama:
      'A local LLM through Ollama. Slower and needs a server plus a model ' +
      'download, but it reads the surrounding page for context and unlocks ' +
      'capture enrichment.',
  };

  const currentEngine = (): Engine =>
    el.engine.value === 'ollama' ? 'ollama' : 'builtin';

  const renderEngine = (): void => {
    const engine = currentEngine();
    el.engineNote.textContent = ENGINE_NOTES[engine];
    if (engine === 'ollama') {
      el.ollamaOnly.removeAttribute('hidden');
    } else {
      el.ollamaOnly.setAttribute('hidden', '');
    }
  };

  const check = (): void => {
    // Nothing to check when no server is involved. Probing anyway would show
    // a red "can't reach Ollama" to a user who correctly has no Ollama.
    if (currentEngine() !== 'ollama') return;
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

  /**
   * Write the form to storage.
   *
   * `announce` is for the Save button, which is the one place a user asked for
   * confirmation. The write-through calls stay quiet: a status line flashing
   * "Saved ✓" every time a dropdown moves is noise, and the dropdown showing
   * the new value is already the confirmation.
   */
  const persist = (announce = false): Promise<void> => {
    const settings: Settings = {
      engine: currentEngine(),
      baseUrl: el.baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl,
      modelId: el.model.value.trim() || DEFAULT_SETTINGS.modelId,
      targetLang: el.lang.value,
      obsidianVault: el.vault.value.trim(),
      obsidianFolder: el.folder.value.trim() || DEFAULT_SETTINGS.obsidianFolder,
      enrichOnCapture: el.enrich.checked,
    };
    return saveSettings(settings)
      .then(() => {
        if (!announce) return;
        el.status.classList.remove('error');
        el.status.textContent = 'Saved ✓';
        window.setTimeout(() => {
          el.status.textContent = '';
        }, 1500);
      })
      .catch(() => {
        // Without this the failure is silent: the status line simply stays
        // blank, which reads exactly like "nothing happened yet". Shown even
        // for a write-through, because a setting that did not stick is worth
        // interrupting for.
        el.status.classList.add('error');
        el.status.textContent = 'Save failed';
      });
  };

  void loadSettings().then((settings) => {
    el.engine.value = settings.engine;
    renderEngine();
    el.baseUrl.value = settings.baseUrl;
    el.model.value = settings.modelId;
    el.lang.value = settings.targetLang;
    el.vault.value = settings.obsidianVault;
    el.folder.value = settings.obsidianFolder;
    el.enrich.checked = settings.enrichOnCapture;
    check();
  });

  el.engine.addEventListener('change', () => {
    renderEngine();
    check();
    void persist();
  });
  el.baseUrl.addEventListener('change', () => {
    check();
    void persist();
  });
  // Re-judged locally: whether a model is installed is answered by the probe
  // already in hand, so retyping the field costs nothing.
  el.model.addEventListener('input', render);

  // Every control writes through as it changes.
  //
  // The Save button used to be the only thing that wrote anything, and
  // "Translate this page" sits above the language selector — so changing the
  // target language and pressing the obvious button next to it translated into
  // the language you had just moved away from. Verified in the popup itself:
  // firing `change` on the selector left `chrome.storage.sync` empty.
  //
  // `change` rather than `input` for the text fields, so a half-typed server
  // URL is not probed and stored on every keystroke; clicking anywhere else
  // blurs the field and fires it.
  for (const field of [el.lang, el.vault, el.folder, el.enrich]) {
    field.addEventListener('change', () => {
      void persist();
    });
  }
  el.model.addEventListener('change', () => {
    void persist();
  });

  el.translatePage.addEventListener('click', () => {
    // Closing immediately is the honest signal that the work moved to the
    // page: the progress badge lives there, and a popup left open would
    // cover the corner it appears in.
    //
    // Persisted first, so the page is translated with what the popup is
    // showing rather than with what was last saved.
    void persist().finally(() => {
      void deps.translateActivePage().finally(() => {
        window.close();
      });
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
    void persist(true);
  });

  return true;
}
