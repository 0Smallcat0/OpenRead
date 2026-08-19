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
import { isExcepted, type AutoTranslate } from '../core/auto-translate';
import { describeRestrictedPage } from '../core/restricted';
import { toBcp47 } from '../core/bcp47';
import type { PackReport } from '../api/builtin';
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
  /**
   * Ask the active tab to translate (or untranslate) itself.
   *
   * Rejects when the message reached nobody. That used to be swallowed and the
   * popup closed anyway, which is the whole of what a user sees when the tab
   * predates the install: a button that closes the window and changes nothing.
   */
  translateActivePage: () => Promise<void>;
  /**
   * Full URL of the tab the popup was opened over, or null.
   *
   * The host alone cannot answer this: `chrome://extensions` and the Web Store
   * are pages Chrome forbids every extension from touching, and the first is
   * not a host at all while the second is an ordinary-looking https one.
   */
  activeUrl: () => Promise<string | null>;
  /**
   * Hostname of the tab the popup was opened over, or null when there is not
   * one — `chrome://` pages, the Web Store, a blank tab. The per-site exception
   * has nothing to name in that case and hides itself.
   */
  activeHost: () => Promise<string | null>;
  /**
   * `<html lang>` of the tab the popup was opened over, or null when it cannot
   * be asked or the page does not say. Chrome's translation models are per
   * language *pair*, so there is no such thing as "is the pack ready" without
   * knowing what the page is in.
   */
  pageLanguage: () => Promise<string | null>;
  /** Has Chrome fetched the model for this pair? Null when it has no answer. */
  packAvailability: (
    source: string,
    target: string,
  ) => Promise<PackReport | null>;
  /**
   * Ask the worker to fetch it, and to own it.
   *
   * Not fetched here. The popup used to run the download itself, because
   * Chrome's gate on starting one wants a user gesture in a document and a
   * message to the worker throws that gesture away — but the gate does not
   * apply in a service worker, and the popup is the worst place in the
   * extension to hold a download: it closes when the user looks away.
   *
   * That is not a lost minute. Measured: a pack interrupted at 85 MB and asked
   * for again sat at zero for three minutes, then Chrome deleted the 85 MB and
   * began from the beginning.
   */
  requestPack: (source: string, target: string) => Promise<void>;
  /**
   * Is the worker already fetching one, and how far in?
   *
   * `packAvailability` cannot answer this — it reports `downloadable` for the
   * whole duration of a download it is itself performing — so without asking
   * the worker, a popup opened two minutes after install tells the user
   * nothing has been downloaded and offers a button to start what is already
   * running.
   */
  packProgress: () => Promise<{
    downloading: boolean;
    loaded: number;
    problem: string | null;
  } | null>;
}

interface Elements {
  form: HTMLFormElement;
  engine: HTMLSelectElement;
  engineNote: HTMLElement;
  ollamaOnly: HTMLElement;
  enrichOnly: HTMLElement | null;
  baseUrl: HTMLInputElement;
  model: HTMLInputElement;
  modelOptions: HTMLDataListElement;
  lang: HTMLSelectElement;
  displayMode: HTMLSelectElement | null;
  hoverTranslate: HTMLSelectElement | null;
  inputLang: HTMLSelectElement | null;
  glossary: HTMLTextAreaElement | null;
  translationStyle: HTMLSelectElement | null;
  translationScale: HTMLSelectElement | null;
  pack: HTMLElement | null;
  packNote: HTMLElement | null;
  downloadPack: HTMLButtonElement | null;
  auto: HTMLSelectElement;
  autoNote: HTMLElement | null;
  siteExceptRow: HTMLElement | null;
  siteExcept: HTMLInputElement | null;
  siteExceptLabel: HTMLElement | null;
  pageNote: HTMLElement | null;
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
  const enrichOnly = root.querySelector<HTMLElement>('#enrichOnly');
  const baseUrl = root.querySelector<HTMLInputElement>('#baseUrl');
  const model = root.querySelector<HTMLInputElement>('#modelId');
  const modelOptions = root.querySelector<HTMLDataListElement>('#modelOptions');
  const lang = root.querySelector<HTMLSelectElement>('#targetLang');
  const displayMode = root.querySelector<HTMLSelectElement>('#displayMode');
  const hoverTranslate =
    root.querySelector<HTMLSelectElement>('#hoverTranslate');
  const inputLang = root.querySelector<HTMLSelectElement>('#inputTargetLang');
  const glossary = root.querySelector<HTMLTextAreaElement>('#glossary');
  const translationStyle =
    root.querySelector<HTMLSelectElement>('#translationStyle');
  const translationScale =
    root.querySelector<HTMLSelectElement>('#translationScale');
  const pack = root.querySelector<HTMLElement>('#pack');
  const packNote = root.querySelector<HTMLElement>('#packNote');
  const downloadPack = root.querySelector<HTMLButtonElement>('#downloadPack');
  const auto = root.querySelector<HTMLSelectElement>('#autoTranslate');
  const autoNote = root.querySelector<HTMLElement>('#autoNote');
  const siteExceptRow = root.querySelector<HTMLElement>('#siteExceptRow');
  const siteExcept = root.querySelector<HTMLInputElement>('#siteExcept');
  const siteExceptLabel = root.querySelector<HTMLElement>('#siteExceptLabel');
  const pageNote = root.querySelector<HTMLElement>('#pageNote');
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
    !auto ||
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
    enrichOnly,
    baseUrl,
    model,
    modelOptions,
    lang,
    displayMode,
    hoverTranslate,
    inputLang,
    glossary,
    translationStyle,
    translationScale,
    pack,
    packNote,
    downloadPack,
    auto,
    autoNote,
    siteExceptRow,
    siteExcept,
    siteExceptLabel,
    pageNote,
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

/**
 * A select's value, or the default when the control is absent or empty.
 *
 * Typed loosely on purpose: these three are unions of string literals and the
 * DOM only knows about strings, so the check that matters is "is this one of
 * ours", which the caller's default answers.
 */
function pick<T extends string>(
  select: HTMLSelectElement | null,
  fallback: T,
): T {
  const value = select?.value;
  return value ? (value as T) : fallback;
}

/** Wire the popup up. Returns false when the document is not the popup. */
export function mountPopup(root: ParentNode, deps: PopupDeps): boolean {
  const el = collect(root);
  if (!el) return false;

  for (const language of TARGET_LANGUAGES) {
    for (const select of [el.lang, el.inputLang]) {
      if (!select) continue;
      const option = document.createElement('option');
      option.value = language;
      option.textContent = language;
      select.appendChild(option);
    }
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

  /** The hosts the user has excluded, and the one this popup was opened over. */
  let except: string[] = [];
  let host: string | null = null;

  /**
   * What the page in front of the user is written in, once it has answered.
   *
   * `en` when it will not say, because it is what most of the web is in and a
   * pack that turns out to be the wrong one only costs the reader the same
   * wait they would have had anyway.
   */
  let pageLang = 'en';
  /** Rising, so a slow availability check cannot overwrite a newer one. */
  let packGeneration = 0;
  /** Stops the follow below from outliving the thing it is following. */
  let packFollow: ReturnType<typeof setInterval> | undefined;

  /**
   * Re-read the worker until the pack is there.
   *
   * The download belongs to the worker now, so this window has nothing to
   * await. Without a poll the note set at the click would be the last thing
   * this popup ever said, and a reader who keeps it open would watch
   * "downloading" forever and never see it land. `renderPack` already knows
   * how to say both things; it just has to be asked again.
   *
   * Two seconds, and it stops itself after fifteen minutes — long enough for
   * 350 MB on a connection this extension is usable on, and short enough that
   * a popup left open on a dead download is not a timer running for the life
   * of the browser.
   */
  const stopFollowing = (): void => {
    if (packFollow !== undefined) clearInterval(packFollow);
    packFollow = undefined;
  };

  const followPack = (): void => {
    // Already following. Restarting would only push the deadline out on every
    // re-render, which is how a poll outlives the window it belongs to.
    if (packFollow !== undefined) return;
    const until = Date.now() + 900_000;
    packFollow = setInterval(() => {
      if (Date.now() > until) {
        stopFollowing();
        return;
      }
      void deps.packAvailability(pageLang, toBcp47(el.lang.value) ?? '').then(
        (state) => {
          if (state === 'available' || state === 'unavailable') stopFollowing();
          renderPack();
        },
        () => undefined,
      );
    }, 2000);
  };
  /** Whether stored settings have reached the form yet. */
  let settingsLoaded = false;

  const setPackNote = (message: string, tone = ''): void => {
    el.pack?.removeAttribute('hidden');
    if (el.packNote) {
      el.packNote.textContent = message;
      el.packNote.className = tone;
    }
  };

  const hidePack = (): void => {
    el.pack?.setAttribute('hidden', '');
  };

  /**
   * Say whether the next translation will have to wait for a download.
   *
   * Only for the built-in engine: Ollama has its own readiness story, told by
   * the connection line above, and a second one about Chrome's packs would
   * report on an engine that is not going to be used.
   */
  const renderPack = (): void => {
    // Nothing to say until the stored engine has reached the form. The page's
    // language and the settings arrive on separate promises in either order,
    // and rendering from the form's initial value would report on the built-in
    // engine to a user who is on Ollama — for as long as it took the other
    // promise to land, or for good if it landed first.
    if (!settingsLoaded) return;
    const mine = ++packGeneration;
    if (currentEngine() !== 'builtin') {
      hidePack();
      return;
    }
    const target = toBcp47(el.lang.value);
    if (!target) {
      // A language only Ollama can serve. The engine note already says so.
      hidePack();
      return;
    }
    void deps.packAvailability(pageLang, target).then(async (availability) => {
      if (mine !== packGeneration) return;
      const pair = `${pageLang} → ${target}`;
      el.downloadPack?.setAttribute('hidden', '');
      switch (availability) {
        case 'available':
          setPackNote(`Ready to translate ${pair} instantly.`, 'ready');
          break;
        case 'downloading':
          setPackNote(
            `Downloading the ${pair} model — about 350 MB, once. ` +
              `Translation works the moment it lands.`,
          );
          break;
        case 'downloadable': {
          // `downloadable` is also what Chrome says while it is downloading —
          // measured at 145,687 ms of `create()` with availability never once
          // saying `downloading` — so the worker is the only thing that knows
          // whether the install-time fetch is already running. Without asking
          // it, this branch tells a user whose pack is 40% in that nothing has
          // been downloaded, and offers a button to start what is running.
          const inFlight = await deps.packProgress().catch(() => null);
          if (mine !== packGeneration) return;
          if (inFlight?.downloading) {
            // However this window arrived at "a download is running" — its own
            // button, a language switch that started one, or simply being
            // opened during the install-time fetch — the note has to keep
            // moving. Rendered once and left alone, it says "downloading"
            // forever, including long after the pack has landed. Caught by
            // `e2e:page`, which switches target language and then waits for
            // the banner to say Ready.
            followPack();
            const percent = Math.round(inFlight.loaded * 100);
            setPackNote(
              percent > 0
                ? `Downloading the ${pair} model, ${String(percent)}% of ` +
                    `about 350 MB. Translation works the moment it lands.`
                : `Downloading the ${pair} model — about 350 MB, once. ` +
                    `Translation works the moment it lands.`,
            );
            break;
          }
          // A stall is the failure a new install actually meets, and the
          // message names the three things worth checking — free disk, a
          // metered connection, chrome://on-device-internals. Offering the
          // button again is right: it is the one thing a user can do about it.
          if (inFlight?.problem) {
            setPackNote(inFlight.problem, 'warn');
            el.downloadPack?.removeAttribute('hidden');
            break;
          }
          // A size rather than a duration. "A minute or two" is right on a
          // fast connection — 352 MB in 82 seconds, measured — and wrong by an
          // order of magnitude on a slow one, and the reader knows which they
          // have far better than this does.
          setPackNote(
            `Chrome has not downloaded the ${pair} model yet — about 350 MB, ` +
              `once. Start it now rather than meeting it mid-sentence.`,
            'warn',
          );
          el.downloadPack?.removeAttribute('hidden');
          break;
        }
        case 'unavailable':
          setPackNote(
            `Chrome cannot translate ${pair}. Switch to Ollama for this pair.`,
            'warn',
          );
          break;
        case 'no-api':
          // This browser has no built-in translator at all, and this line is
          // the only place a reader will be told before they press the button
          // and watch nothing happen. It used to hide the banner instead, on
          // the grounds that "the engine note covers that" — the engine note
          // is a fixed sentence saying there is nothing to install, so the
          // popup reported that all was well on a browser that could not
          // translate a word. Reproduced in `e2e:first-run`.
          setPackNote(
            'This browser has no built-in translator, so nothing here will ' +
              'work until you update to Chrome 138 or later — or switch the ' +
              'translator above to Ollama.',
            'warn',
          );
          break;
        default:
          // Could not ask: an unknown language code, a malformed tag. Not
          // knowing is not the same as bad news, and a warning about a
          // question that was never put would be inventing one.
          hidePack();
      }
    });
  };

  const AUTO_NOTES: Record<AutoTranslate, string> = {
    off: 'Pages are translated only when you ask.',
    foreign:
      'A page that says it is in another language is translated as it loads. ' +
      'One that does not say is left alone.',
    always:
      'Every page is translated as it loads, including ones already in your ' +
      'language.',
  };

  const currentAuto = (): AutoTranslate =>
    el.auto.value === 'always'
      ? 'always'
      : el.auto.value === 'foreign'
        ? 'foreign'
        : 'off';

  const renderAuto = (): void => {
    const mode = currentAuto();
    if (el.autoNote) el.autoNote.textContent = AUTO_NOTES[mode];
    // Nothing to exclude from a feature that is off, and nothing to name on a
    // tab that has no host.
    if (mode === 'off' || !host) {
      el.siteExceptRow?.setAttribute('hidden', '');
      return;
    }
    el.siteExceptRow?.removeAttribute('hidden');
    if (el.siteExceptLabel) el.siteExceptLabel.textContent = `Never on ${host}`;
    if (el.siteExcept) el.siteExcept.checked = isExcepted(host, except);
  };

  const renderEngine = (): void => {
    const engine = currentEngine();
    el.engineNote.textContent = ENGINE_NOTES[engine];
    if (engine === 'ollama') {
      el.ollamaOnly.removeAttribute('hidden');
      el.enrichOnly?.removeAttribute('hidden');
    } else {
      el.ollamaOnly.setAttribute('hidden', '');
      el.enrichOnly?.setAttribute('hidden', '');
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
      autoTranslate: currentAuto(),
      autoTranslateExcept: except,
      // Read back through the defaults, so a document without these controls —
      // an older popup, a test fixture — stores what was already there rather
      // than an empty string the content script would have to guess about.
      displayMode: pick(el.displayMode, DEFAULT_SETTINGS.displayMode),
      translationStyle: pick(
        el.translationStyle,
        DEFAULT_SETTINGS.translationStyle,
      ),
      translationScale: pick(
        el.translationScale,
        DEFAULT_SETTINGS.translationScale,
      ),
      hoverTranslate: pick(el.hoverTranslate, DEFAULT_SETTINGS.hoverTranslate),
      inputTargetLang: pick(el.inputLang, DEFAULT_SETTINGS.inputTargetLang),
      glossary: el.glossary ? el.glossary.value : DEFAULT_SETTINGS.glossary,
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
    el.auto.value = settings.autoTranslate;
    if (el.displayMode) el.displayMode.value = settings.displayMode;
    if (el.translationStyle)
      el.translationStyle.value = settings.translationStyle;
    if (el.translationScale)
      el.translationScale.value = settings.translationScale;
    if (el.hoverTranslate) el.hoverTranslate.value = settings.hoverTranslate;
    if (el.inputLang) el.inputLang.value = settings.inputTargetLang;
    if (el.glossary) el.glossary.value = settings.glossary;
    except = [...settings.autoTranslateExcept];
    renderAuto();
    el.vault.value = settings.obsidianVault;
    el.folder.value = settings.obsidianFolder;
    el.enrich.checked = settings.enrichOnCapture;
    settingsLoaded = true;
    renderPack();
    check();
  });

  // The host arrives on its own schedule, and it only changes what the
  // exception row says, so it re-renders rather than gating the load above.
  void deps.activeHost().then((value) => {
    host = value;
    renderAuto();
  });

  void deps.pageLanguage().then((value) => {
    if (value?.trim()) pageLang = value.trim();
    renderPack();
  });

  el.downloadPack?.addEventListener('click', () => {
    const target = toBcp47(el.lang.value);
    if (!target) return;
    const source = pageLang;
    el.downloadPack?.setAttribute('hidden', '');
    // "You can close this" rather than "keep this open", which is the whole
    // point of handing it to the worker: a download this window was holding
    // died with the window, and dying costs the entire partial download plus
    // the three minutes Chrome waits before starting over.
    setPackNote(
      `Downloading the ${source} → ${target} model — about 350 MB, once. ` +
        `You can close this window; it carries on without it.`,
    );
    void deps.requestPack(source, target).then(
      () => {
        // The worker owns the download; this window only reports on it. Left
        // at that, the note just set would be the last thing this popup ever
        // said — a reader who keeps it open would watch "downloading" forever
        // and never see it land.
        followPack();
      },
      (error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        setPackNote(`Could not start the download — ${reason}`, 'warn');
        el.downloadPack?.removeAttribute('hidden');
      },
    );
  });

  el.auto.addEventListener('change', () => {
    renderAuto();
    void persist();
  });

  el.siteExcept?.addEventListener('change', () => {
    if (!host) return;
    if (el.siteExcept?.checked) {
      if (!isExcepted(host, except)) except = [...except, host];
    } else {
      // Every entry that covers this host, not just an exact match: a stored
      // `example.com` is why `www.example.com` is excluded, so unchecking on
      // the subdomain has to be able to reach it. Otherwise the box springs
      // back on the next open and the control looks broken.
      except = except.filter((entry) => !isExcepted(host ?? '', [entry]));
    }
    renderAuto();
    void persist();
  });

  el.engine.addEventListener('change', () => {
    renderEngine();
    renderPack();
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
  for (const field of [
    el.displayMode,
    el.translationStyle,
    el.translationScale,
    el.hoverTranslate,
    el.inputLang,
    el.glossary,
  ]) {
    field?.addEventListener('change', () => {
      void persist();
    });
  }

  for (const field of [el.lang, el.vault, el.folder, el.enrich]) {
    field.addEventListener('change', () => {
      void persist();
    });
  }
  // A different target is a different pair, and Chrome's packs are per pair —
  // which is the common way to meet the download at all.
  el.lang.addEventListener('change', renderPack);
  el.model.addEventListener('change', () => {
    void persist();
  });

  /** Say something about the tab the popup was opened over, or nothing. */
  const setPageNote = (message: string | null): void => {
    if (!el.pageNote) return;
    el.pageNote.textContent = message ?? '';
    el.pageNote.hidden = message === null;
  };
  setPageNote(null);

  /**
   * Whether the page in front of the user is one Chrome forbids.
   *
   * Asked and answered before the press, because after it there is nothing to
   * see: the message goes to a tab with no content script in it, the page does
   * not change, and the popup closes. `core/restricted.ts` has the list and
   * why the store listing is the one that matters most.
   */
  /**
   * What the address bar says, once it has been asked. `undefined` until then.
   *
   * Kept because the answer changes what an undelivered message means. Chrome
   * hands an extension a tab's URL only where it has permission, and it has
   * none on its own pages — measured: a `chrome://extensions` tab reports a
   * URL of `null`, while the Web Store listing reports its address in full.
   * So a null URL is itself the evidence that this is a page no extension may
   * touch, and a real URL plus a failed delivery is a tab that predates the
   * install.
   */
  let pageUrl: string | null | undefined;

  void deps.activeUrl().then((url) => {
    pageUrl = url;
    const reason = describeRestrictedPage(url);
    if (!reason) return;
    setPageNote(reason);
    el.translatePage.disabled = true;
  });

  /** Why the press did nothing, in the words the evidence supports. */
  const undeliveredReason = (): string => {
    if (pageUrl === null) {
      return (
        'Chrome does not allow any extension to see or change this page, so ' +
        'OpenRead cannot translate it. Try it on an ordinary web page.'
      );
    }
    if (pageUrl === undefined) {
      return (
        'OpenRead could not reach this page. Reload it and press again — and ' +
        "if it is one of Chrome's own pages, no extension can run there."
      );
    }
    return (
      'This tab was already open when OpenRead was installed, so it has not ' +
      'been set up yet. Reload the page and press again.'
    );
  };

  el.translatePage.addEventListener('click', () => {
    // Closing immediately is the honest signal that the work moved to the
    // page: the progress badge lives there, and a popup left open would
    // cover the corner it appears in.
    //
    // Persisted first, so the page is translated with what the popup is
    // showing rather than with what was last saved.
    void persist().finally(() => {
      void deps.translateActivePage().then(
        () => {
          window.close();
        },
        // The message reached nobody. Chrome injects a content script when a
        // page loads, so every tab that was already open when the extension
        // was installed has none — which is every tab a user has at the moment
        // they install from the Web Store. Closing the popup anyway, which is
        // what this used to do, is a button that makes the window disappear
        // and nothing else happen.
        () => {
          setPageNote(undeliveredReason());
        },
      );
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
