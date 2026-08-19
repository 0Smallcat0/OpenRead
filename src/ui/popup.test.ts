// @vitest-environment jsdom
/**
 * The popup is the only surface a user visits before anything works, so it is
 * the only place a broken setup can be reported before it costs a translation.
 * These tests drive it against a stubbed probe, so every failure mode a first
 * run can hit — server down, origin refused, model not pulled — is a test
 * rather than a server someone has to misconfigure by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mountPopup, type PopupDeps } from './popup';
import type { ConnectionProbe } from '../core/diagnostics';

const MARKUP = `
  <button id="translatePage" type="button">Translate this page</button>
  <p id="pageNote" hidden></p>
  <form id="settingsForm">
    <select id="engine">
      <option value="builtin">builtin</option>
      <option value="ollama">ollama</option>
    </select>
    <p id="engineNote"></p>
    <div id="ollamaOnly">
    <input id="baseUrl" type="text" />
    <div id="connection"></div>
    <div id="fix" hidden><code id="fixCommand"></code><button id="copyFix" type="button">Copy</button></div>
    <input id="modelId" type="text" list="modelOptions" />
    <datalist id="modelOptions"></datalist>
    </div>
    <select id="targetLang"></select>
    <select id="displayMode">
      <option value="bilingual">bilingual</option>
      <option value="translationOnly">translationOnly</option>
    </select>
    <select id="translationStyle">
      <option value="line">line</option>
      <option value="plain">plain</option>
      <option value="dashed">dashed</option>
      <option value="highlight">highlight</option>
    </select>
    <select id="inputTargetLang"></select>
    <select id="hoverTranslate">
      <option value="alt">alt</option>
      <option value="ctrl">ctrl</option>
      <option value="shift">shift</option>
      <option value="off">off</option>
    </select>
    <select id="translationScale">
      <option value="small">small</option>
      <option value="same">same</option>
      <option value="large">large</option>
    </select>
    <div id="pack" hidden>
      <div id="packNote"></div>
      <button id="downloadPack" type="button">Download it now</button>
    </div>
    <select id="autoTranslate">
      <option value="off">off</option>
      <option value="foreign">foreign</option>
      <option value="always">always</option>
    </select>
    <p id="autoNote"></p>
    <label class="checkbox" id="siteExceptRow" hidden>
      <input id="siteExcept" type="checkbox" />
      <span id="siteExceptLabel"></span>
    </label>
    <textarea id="glossary"></textarea>
    <input id="obsidianVault" type="text" />
    <input id="obsidianFolder" type="text" />
    <input id="enrichOnCapture" type="checkbox" />
    <button id="saveBtn" type="submit">Save</button>
    <div id="status"></div>
  </form>
`;

let stored: Record<string, unknown>;
let packState:
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available'
  | 'no-api'
  | null;
let downloads: number;
let probe: ReturnType<typeof vi.fn>;
let written: string[];
let pageTranslations: number;

function stubChrome(): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: () => Promise.resolve({ ...stored }),
        set: (values: Record<string, unknown>) => {
          Object.assign(stored, values);
          return Promise.resolve();
        },
      },
    },
  };
}

function deps(overrides: Partial<PopupDeps> = {}): PopupDeps {
  return {
    probe: probe as unknown as PopupDeps['probe'],
    platformOs: () => Promise.resolve('mac'),
    activeHost: () => Promise.resolve('example.com'),
    activeUrl: () => Promise.resolve('https://example.com/article'),
    pageLanguage: () => Promise.resolve('en'),
    packAvailability: () => Promise.resolve(packState),
    // "Nothing in flight" by default, so every test that is not about the
    // install-time fetch sees the branch a user with no prefetch running does.
    packProgress: () =>
      Promise.resolve({ downloading: false, loaded: 0, problem: null }),
    requestPack: (_source, _target) => {
      downloads++;
      return Promise.resolve();
    },
    writeClipboard: (text: string) => {
      written.push(text);
      return Promise.resolve();
    },
    translateActivePage: () => {
      pageTranslations++;
      return Promise.resolve();
    },
    ...overrides,
  };
}

/** Let the mount's chained promises (settings -> probe -> render) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function $(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}

beforeEach(() => {
  // The popup closes itself after handing a page translation off. jsdom takes
  // that literally and tears the window down, which would strand every test
  // after this one; the close itself is asserted below.
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
  document.body.innerHTML = MARKUP;
  stored = {
    // These suites are about the Ollama engine's connection check, which only
    // runs when Ollama is the chosen engine. The built-in engine gets its own
    // describe block below.
    engine: 'ollama',
    baseUrl: 'http://localhost:11434',
    modelId: 'qwen3:latest',
    targetLang: 'Traditional Chinese',
  };
  written = [];
  pageTranslations = 0;
  packState = 'available';
  downloads = 0;
  probe = vi.fn((): Promise<ConnectionProbe> =>
    Promise.resolve({ kind: 'ok', models: ['qwen3:latest'] }),
  );
  stubChrome();
});

describe('mountPopup', () => {
  it('does nothing on a document that is not the popup', () => {
    document.body.innerHTML = '<p>not the popup</p>';
    expect(mountPopup(document, deps())).toBe(false);
  });

  it('checks the connection on open, without being asked', async () => {
    mountPopup(document, deps());
    await settle();
    expect(probe).toHaveBeenCalledWith(
      'http://localhost:11434',
      expect.anything(),
    );
    expect($('connection').textContent).toContain('Connected');
    expect($('connection').className).toBe('ok');
  });

  it('offers the models the server reported', async () => {
    probe.mockResolvedValue({
      kind: 'ok',
      models: ['qwen3:latest', 'llama3.1:latest'],
    });
    mountPopup(document, deps());
    await settle();
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>('#modelOptions option'),
    ).map((o) => o.value);
    expect(options).toEqual(['qwen3:latest', 'llama3.1:latest']);
  });

  it('shows a copyable fix when the server refuses this extension', async () => {
    probe.mockResolvedValue({ kind: 'forbidden' });
    mountPopup(document, deps());
    await settle();

    expect($('connection').className).toBe('error');
    expect($('fix').hasAttribute('hidden')).toBe(false);
    expect($('fixCommand').textContent).toContain('launchctl');

    $('copyFix').dispatchEvent(new Event('click'));
    await settle();
    expect(written).toEqual([
      'launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"',
    ]);
    expect($('copyFix').textContent).toBe('Copied');
  });

  it('hands a page translation to the active tab', async () => {
    mountPopup(document, deps());
    await settle();
    $('translatePage').dispatchEvent(new Event('click'));
    await settle();
    expect(pageTranslations).toBe(1);
    // Closing is the honest signal that the work moved to the page, where the
    // progress badge lives — in the corner an open popup would cover.
    expect(window.close).toHaveBeenCalled();
  });

  it('says so on a page Chrome will not let it run on', async () => {
    // The first page anyone sees with this installed is the Web Store listing
    // they installed it from, and Chrome forbids every extension there. The
    // button used to be delivered to nobody, the page did not change, and the
    // popup closed — which is exactly what a broken extension looks like.
    mountPopup(
      document,
      deps({
        activeUrl: () =>
          Promise.resolve('https://chromewebstore.google.com/detail/abc'),
      }),
    );
    await settle();

    expect($('pageNote').hidden).toBe(false);
    expect($('pageNote').textContent).toMatch(/extension store/);
    expect(($('translatePage') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says nothing about an ordinary page', async () => {
    mountPopup(document, deps());
    await settle();
    expect($('pageNote').hidden).toBe(true);
    expect(($('translatePage') as HTMLButtonElement).disabled).toBe(false);
  });

  it('tells the user to reload when the message reached nobody', async () => {
    // Chrome injects a content script as a page loads, so every tab that was
    // already open when the extension was installed has none — which is every
    // tab a user has at the moment they install. This used to be swallowed and
    // the popup closed anyway.
    // `vi.spyOn` on an already-spied method hands back the same mock, calls and
    // all, so the count carries over from the test that asserts the popup does
    // close. Cleared here rather than trusted.
    vi.mocked(window.close).mockClear();
    mountPopup(
      document,
      deps({
        translateActivePage: () =>
          Promise.reject(new Error('Receiving end does not exist.')),
      }),
    );
    await settle();
    $('translatePage').dispatchEvent(new Event('click'));
    await settle();

    expect($('pageNote').textContent).toMatch(/Reload the page/);
    // And it stays open to be read, rather than closing on a message nobody
    // has seen yet.
    expect(window.close).not.toHaveBeenCalled();
  });

  it('blames Chrome, not the tab, on a page whose address it cannot even see', async () => {
    // Measured: a `chrome://extensions` tab reports a URL of null to an
    // extension with `<all_urls>`, while the Web Store listing reports its
    // address in full. So a null address is itself the evidence — and telling
    // this user to reload the page would be advice that cannot work.
    vi.mocked(window.close).mockClear();
    mountPopup(
      document,
      deps({
        activeUrl: () => Promise.resolve(null),
        translateActivePage: () =>
          Promise.reject(new Error('Receiving end does not exist.')),
      }),
    );
    await settle();
    $('translatePage').dispatchEvent(new Event('click'));
    await settle();

    expect($('pageNote').textContent).toMatch(/does not allow any extension/);
    expect($('pageNote').textContent).not.toMatch(/already open/);
  });

  it('hides the fix row when there is nothing to fix', async () => {
    mountPopup(document, deps());
    await settle();
    expect($('fix').hasAttribute('hidden')).toBe(true);
  });

  it('warns about a model the server does not have, as it is typed', async () => {
    probe.mockResolvedValue({ kind: 'ok', models: ['qwen3:latest'] });
    mountPopup(document, deps());
    await settle();
    expect($('connection').className).toBe('ok');

    const model = $('modelId') as HTMLInputElement;
    model.value = 'qwen3:latst';
    model.dispatchEvent(new Event('input'));

    expect($('connection').className).toBe('warn');
    expect($('fixCommand').textContent).toBe('ollama pull qwen3:latst');
    // Re-judged from the probe already in hand — no second round trip.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-checks when the server URL changes', async () => {
    mountPopup(document, deps());
    await settle();

    const url = $('baseUrl') as HTMLInputElement;
    url.value = 'http://192.168.1.10:11434';
    url.dispatchEvent(new Event('change'));
    await settle();

    expect(probe).toHaveBeenLastCalledWith(
      'http://192.168.1.10:11434',
      expect.anything(),
    );
  });

  it('does not let a slow first probe overwrite a newer one', async () => {
    // Typing a URL is enough to start two probes; if the first resolves last,
    // the popup would report the old server's state about the new one.
    let releaseFirst: (probe: ConnectionProbe) => void = () => undefined;
    probe
      .mockImplementationOnce(
        () =>
          new Promise<ConnectionProbe>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue({
        kind: 'ok',
        models: ['qwen3:latest', 'llama3.1:latest'],
      });

    mountPopup(document, deps());
    await settle();

    const url = $('baseUrl') as HTMLInputElement;
    url.value = 'http://elsewhere:11434';
    url.dispatchEvent(new Event('change'));
    await settle();
    expect($('connection').textContent).toContain('2 models');

    releaseFirst({ kind: 'forbidden' });
    await settle();
    expect($('connection').textContent).toContain('2 models');
    expect($('connection').className).toBe('ok');
    expect($('fix').hasAttribute('hidden')).toBe(true);
  });

  it('empties the model list when a new server offers nothing', async () => {
    probe.mockResolvedValueOnce({ kind: 'ok', models: ['qwen3:latest'] });
    mountPopup(document, deps());
    await settle();
    expect(document.querySelectorAll('#modelOptions option')).toHaveLength(1);

    probe.mockResolvedValue({ kind: 'unreachable' });
    const url = $('baseUrl') as HTMLInputElement;
    url.value = 'http://down:11434';
    url.dispatchEvent(new Event('change'));
    await settle();

    // Stale options would suggest a server that is not answering has models.
    expect(document.querySelectorAll('#modelOptions option')).toHaveLength(0);
  });

  it('still saves settings, including a model the server lacks', async () => {
    probe.mockResolvedValue({ kind: 'unreachable' });
    mountPopup(document, deps());
    await settle();

    (document.getElementById('modelId') as HTMLInputElement).value = 'gemma3';
    $('settingsForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    await settle();

    // An unreachable server must not become a reason the popup cannot be used
    // — configuring it is exactly what a user does before starting Ollama.
    expect(stored.modelId).toBe('gemma3');
    expect(stored.engine).toBe('ollama');
    expect($('status').textContent).toBe('Saved ✓');
  });

  it('reports a failed save instead of going quiet', async () => {
    mountPopup(document, deps());
    await settle();
    (
      globalThis as unknown as {
        chrome: { storage: { sync: { set: () => Promise<void> } } };
      }
    ).chrome.storage.sync.set = () => Promise.reject(new Error('quota'));

    $('settingsForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    await settle();
    expect($('status').textContent).toBe('Save failed');
    expect($('status').classList.contains('error')).toBe(true);
  });

  it('falls back to the default URL when the field is blank', async () => {
    stored = { ...stored, baseUrl: '' };
    mountPopup(document, deps());
    await settle();
    expect(probe).toHaveBeenCalledWith(
      'http://localhost:11434',
      expect.anything(),
    );
  });
});

describe('the engine selector', () => {
  it('defaults a fresh install to the engine that needs no setup', async () => {
    stored = {};
    mountPopup(document, deps());
    await settle();
    expect(($('engine') as HTMLSelectElement).value).toBe('builtin');
  });

  it('does not probe a server the built-in engine never uses', async () => {
    // Probing anyway shows a red "can't reach Ollama" to a user who correctly
    // has no Ollama — the exact false alarm this engine exists to remove.
    stored = { engine: 'builtin' };
    mountPopup(document, deps());
    await settle();
    expect(probe).not.toHaveBeenCalled();
  });

  it('hides every Ollama-only control while built-in is chosen', async () => {
    stored = { engine: 'builtin' };
    mountPopup(document, deps());
    await settle();
    expect($('ollamaOnly').hasAttribute('hidden')).toBe(true);
  });

  it('reveals them and probes when the user switches to Ollama', async () => {
    stored = { engine: 'builtin' };
    mountPopup(document, deps());
    await settle();

    const engine = $('engine') as HTMLSelectElement;
    engine.value = 'ollama';
    engine.dispatchEvent(new Event('change'));
    await settle();

    expect($('ollamaOnly').hasAttribute('hidden')).toBe(false);
    expect(probe).toHaveBeenCalled();
  });

  it('explains what each engine costs, not just its name', async () => {
    stored = { engine: 'builtin' };
    mountPopup(document, deps());
    await settle();
    expect($('engineNote').textContent).toContain('Nothing to install');

    const engine = $('engine') as HTMLSelectElement;
    engine.value = 'ollama';
    engine.dispatchEvent(new Event('change'));
    expect($('engineNote').textContent).toContain('context');
  });

  it('saves the chosen engine', async () => {
    stored = { engine: 'builtin' };
    mountPopup(document, deps());
    await settle();

    const engine = $('engine') as HTMLSelectElement;
    engine.value = 'ollama';
    engine.dispatchEvent(new Event('change'));
    $('settingsForm').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    await settle();
    expect(stored.engine).toBe('ollama');
  });
});

describe('settings are written through as they change', () => {
  // The trap this closes: "Translate this page" sits above the language
  // selector, and only the Save button wrote anything. Verified in the real
  // popup before the fix — firing `change` on the selector left
  // `chrome.storage.sync` empty, so the obvious next click translated into the
  // language the user had just moved away from.
  async function open(): Promise<HTMLSelectElement> {
    document.body.innerHTML = MARKUP;
    const select = document.getElementById('targetLang') as HTMLSelectElement;
    for (const name of ['Traditional Chinese', 'Japanese', 'Korean']) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    mountPopup(document, deps());
    await settle();
    return select;
  }

  it('stores a target language the moment it is picked', async () => {
    const select = await open();
    expect(stored.targetLang).toBe('Traditional Chinese');

    select.value = 'Japanese';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(stored.targetLang).toBe('Japanese');
  });

  it('stores the engine the moment it is switched', async () => {
    await open();
    const engine = document.getElementById('engine') as HTMLSelectElement;
    engine.value = 'ollama';
    engine.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(stored.engine).toBe('ollama');
  });

  it('stores a glossary the moment it is typed', async () => {
    await open();
    const glossary = document.getElementById('glossary') as HTMLTextAreaElement;
    const typed = `# names
OpenRead

bug = 瑕疵`;
    glossary.value = typed;
    glossary.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    // Stored verbatim, not parsed: what comes back has to be what was typed,
    // comments and blank lines included, or editing it is destructive.
    expect(stored.glossary).toBe(typed);
  });

  it('stores the capture fields as they are left', async () => {
    await open();
    const vault = document.getElementById('obsidianVault') as HTMLInputElement;
    vault.value = 'My Vault';
    vault.dispatchEvent(new Event('change', { bubbles: true }));
    const enrich = document.getElementById(
      'enrichOnCapture',
    ) as HTMLInputElement;
    enrich.checked = true;
    enrich.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(stored.obsidianVault).toBe('My Vault');
    expect(stored.enrichOnCapture).toBe(true);
  });

  it('writes before translating, so the page gets what the popup shows', async () => {
    const select = await open();
    select.value = 'Korean';
    // No `change` event: the user picked with the keyboard and clicked
    // straight through, which is exactly the sequence that used to lose it.
    const order: string[] = [];
    const originalSet = (
      globalThis as unknown as {
        chrome: { storage: { sync: { set: (v: unknown) => Promise<void> } } };
      }
    ).chrome.storage.sync.set;
    (
      globalThis as unknown as {
        chrome: { storage: { sync: { set: (v: unknown) => Promise<void> } } };
      }
    ).chrome.storage.sync.set = (values: unknown) => {
      order.push('saved');
      return originalSet(values);
    };

    document
      .getElementById('translatePage')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    order.push('translated');

    expect(stored.targetLang).toBe('Korean');
    expect(order[0]).toBe('saved');
  });

  it('still says "Saved ✓" when the button is used', async () => {
    await open();
    document
      .getElementById('settingsForm')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(document.getElementById('status')?.textContent).toBe('Saved ✓');
  });

  it('does not announce a write-through', async () => {
    const select = await open();
    select.value = 'Japanese';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(document.getElementById('status')?.textContent).toBe('');
  });
});

describe('automatic translation', () => {
  /** Mount over a page whose host the popup can name. */
  async function open(host: string | null = 'example.com'): Promise<void> {
    document.body.innerHTML = MARKUP;
    mountPopup(document, deps({ activeHost: () => Promise.resolve(host) }));
    await settle();
  }

  const mode = (): HTMLSelectElement => $('autoTranslate') as HTMLSelectElement;
  const siteExcept = (): HTMLInputElement =>
    $('siteExcept') as HTMLInputElement;

  it('is off until it is asked for', async () => {
    // An extension that starts rewriting pages the moment it is installed is
    // one the user has not consented to yet.
    await open();
    expect(mode().value).toBe('off');
    expect($('siteExceptRow').hasAttribute('hidden')).toBe(true);
  });

  it('stores the mode the moment it is picked', async () => {
    await open();
    mode().value = 'foreign';
    mode().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(stored.autoTranslate).toBe('foreign');
  });

  it('offers the per-site exception only once it has something to except', async () => {
    await open();
    mode().value = 'foreign';
    mode().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect($('siteExceptRow').hasAttribute('hidden')).toBe(false);
    expect($('siteExceptLabel').textContent).toBe('Never on example.com');
  });

  it('stays hidden on a tab with no host to name', async () => {
    // chrome://, the Web Store, a blank tab. A checkbox reading "Never on
    // null" is worse than no checkbox.
    await open(null);
    mode().value = 'always';
    mode().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect($('siteExceptRow').hasAttribute('hidden')).toBe(true);
  });

  it('adds and removes the host as the box is ticked', async () => {
    await open();
    mode().value = 'foreign';
    mode().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    siteExcept().checked = true;
    siteExcept().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(stored.autoTranslateExcept).toEqual(['example.com']);

    siteExcept().checked = false;
    siteExcept().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(stored.autoTranslateExcept).toEqual([]);
  });

  it('unticks a subdomain by removing the parent that covered it', async () => {
    // A stored `example.com` is why `news.example.com` is excluded. Leaving it
    // in place would spring the box back on the next open, and the control
    // would look broken.
    stored.autoTranslate = 'foreign';
    stored.autoTranslateExcept = ['example.com', 'other.test'];
    await open('news.example.com');

    expect(siteExcept().checked).toBe(true);
    siteExcept().checked = false;
    siteExcept().dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(stored.autoTranslateExcept).toEqual(['other.test']);
  });
});

describe('the language pack, before it is needed', () => {
  // The longest wait anywhere in this product: 30 s to two minutes, once per
  // language pair per profile. Met on a first press it is indistinguishable
  // from the extension being broken.
  async function open(
    overrides: Partial<PopupDeps> = {},
    engine: 'builtin' | 'ollama' = 'builtin',
  ): Promise<HTMLSelectElement> {
    // The file's shared fixture stores the Ollama engine, because most of the
    // tests around it are about the Ollama connection line. Chrome's language
    // packs belong to the other engine.
    stored.engine = engine;
    document.body.innerHTML = MARKUP;
    const select = document.getElementById('targetLang') as HTMLSelectElement;
    mountPopup(document, deps(overrides));
    await settle();
    return select;
  }

  it('says so before the first press, and offers to get it over with', async () => {
    packState = 'downloadable';
    await open();

    expect($('pack').hasAttribute('hidden')).toBe(false);
    expect($('packNote').textContent).toContain('en → zh-Hant');
    expect($('packNote').textContent).toContain('has not downloaded');
    expect($('downloadPack').hasAttribute('hidden')).toBe(false);
  });

  it('reports the fetch the worker already started, and does not offer it again', async () => {
    // `availability` says `downloadable` for the whole duration of a download
    // it is itself performing, so this branch is reached with the pack already
    // on its way. Telling that user "Chrome has not downloaded it yet" and
    // handing them a button to start it is two wrong things at once.
    packState = 'downloadable';
    await open({
      packProgress: () =>
        Promise.resolve({ downloading: true, loaded: 0.34, problem: null }),
    });

    expect($('packNote').textContent).toContain('Downloading');
    expect($('packNote').textContent).toContain('34%');
    expect($('downloadPack').hasAttribute('hidden')).toBe(true);
  });

  it('gives no percentage until one has moved', async () => {
    packState = 'downloadable';
    await open({
      packProgress: () =>
        Promise.resolve({ downloading: true, loaded: 0, problem: null }),
    });

    expect($('packNote').textContent).toContain('Downloading');
    expect($('packNote').textContent).not.toContain('0%');
  });

  it('passes on why the worker gave up, and offers the button again', async () => {
    // A stalled component download is what a new install actually meets —
    // three fresh profiles in one evening stopped at 43%, 11% and 122 MB and
    // never moved. Until this, the worker met that with a `console.warn`.
    packState = 'downloadable';
    await open({
      packProgress: () =>
        Promise.resolve({
          downloading: false,
          loaded: 0,
          problem:
            "Chrome's language-pack download has not moved for three minutes.",
        }),
    });

    expect($('packNote').textContent).toContain('has not moved');
    expect($('downloadPack').hasAttribute('hidden')).toBe(false);
  });

  it('falls back to the plain note when the worker cannot be asked', async () => {
    // A worker that is asleep, or an older build answering nothing. Not
    // knowing is not bad news, and the old branch is still correct.
    packState = 'downloadable';
    await open({ packProgress: () => Promise.resolve(null) });

    expect($('packNote').textContent).toContain('has not downloaded');
    expect($('downloadPack').hasAttribute('hidden')).toBe(false);
  });

  it('hands the click to the worker, and says the window can be closed', async () => {
    // The popup is the worst place in the extension to hold a download: it
    // closes the moment the user looks at anything else, and a pack that dies
    // partway costs the whole partial download plus the three minutes Chrome
    // waits before starting over. Measured at 85 MB thrown away.
    packState = 'downloadable';
    await open();

    $('downloadPack').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(downloads).toBe(1);
    expect($('packNote').textContent).toContain('350 MB');
    expect($('packNote').textContent).toContain('can close this window');
    expect($('downloadPack').hasAttribute('hidden')).toBe(true);
  });

  it('keeps reporting until the pack lands, then says it is ready', async () => {
    // The download belongs to the worker, so this window has nothing to await.
    // Without a poll the note set at the click is the last thing the popup
    // ever says, and a reader who keeps it open watches "downloading" forever.
    // Caught by `e2e:page`, which presses the button and waits for "Ready".
    packState = 'downloadable';
    vi.useFakeTimers();
    try {
      await open();
      $('downloadPack').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect($('packNote').textContent).toContain('can close this window');

      // The worker finishes it.
      packState = 'available';
      await vi.advanceTimersByTimeAsync(2500);

      expect($('packNote').textContent).toContain('Ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reporting a download it did not start, until that one lands too', async () => {
    // Switching target language names a pair nobody has, and the worker starts
    // fetching it on the settings write — so this window arrives at
    // "downloading" with no button ever pressed. Rendered once and left alone,
    // that note says "downloading" forever, including long after the pack is
    // there. Caught by `e2e:page`.
    packState = 'downloadable';
    vi.useFakeTimers();
    try {
      await open({
        packProgress: () =>
          Promise.resolve({ downloading: true, loaded: 0.2, problem: null }),
      });
      expect($('packNote').textContent).toContain('Downloading');

      packState = 'available';
      await vi.advanceTimersByTimeAsync(2500);

      expect($('packNote').textContent).toContain('Ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers the button again when the worker would not take it', async () => {
    packState = 'downloadable';
    await open({
      requestPack: () => Promise.reject(new Error('the worker is not there')),
    });

    $('downloadPack').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect($('packNote').textContent).toContain('not there');
    expect($('downloadPack').hasAttribute('hidden')).toBe(false);
  });

  it('says what to do when Chrome will not do the pair at all', async () => {
    packState = 'unavailable';
    await open();

    expect($('packNote').textContent).toContain('Ollama');
    expect($('downloadPack').hasAttribute('hidden')).toBe(true);
  });

  it('stays out of the way on the Ollama engine', async () => {
    // Ollama has its own readiness story, told by the connection line. A
    // second one about Chrome's packs would report on an engine that is not
    // going to be used.
    packState = 'downloadable';
    await open({}, 'ollama');

    expect($('pack').hasAttribute('hidden')).toBe(true);
  });

  it('warns when the browser has no built-in translator at all', async () => {
    // The popup used to hide this banner in that case, with a comment saying
    // the engine note covered it. The engine note is a fixed sentence reading
    // "Nothing to install — Chrome downloads the language pack the first time
    // you use it", so on a browser that cannot translate a word the popup
    // reported that everything was fine, and the reader's only other clue was
    // an on-page message that erased itself after 2.5 seconds. Reproduced in
    // `e2e:first-run` with the API switched off.
    packState = 'no-api';
    await open();

    expect($('pack').hasAttribute('hidden')).toBe(false);
    expect($('packNote').textContent).toMatch(/no built-in translator/i);
    expect($('packNote').textContent).toMatch(/Chrome 138|Ollama/);
  });

  it('says nothing when it could not ask about the pair', async () => {
    // Null is "no answer" — an unknown language code, a malformed tag. Not
    // knowing is not the same as bad news, and this case is why the one above
    // needed a value of its own.
    packState = null;
    await open();

    expect($('pack').hasAttribute('hidden')).toBe(true);
  });

  it('asks again when the target language changes, since packs are per pair', async () => {
    const pairs: string[] = [];
    const select = await open({
      packAvailability: (source, target) => {
        pairs.push(`${source}->${target}`);
        return Promise.resolve('available');
      },
    });

    select.value = 'Japanese';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(pairs).toContain('en->ja');
  });

  it('uses the language the page actually declares', async () => {
    const pairs: string[] = [];
    await open({
      pageLanguage: () => Promise.resolve('ja'),
      packAvailability: (source, target) => {
        pairs.push(`${source}->${target}`);
        return Promise.resolve('available');
      },
    });

    expect(pairs).toContain('ja->zh-Hant');
  });
});

/**
 * The markup above is hand-written, and every test in this file passes against
 * it whether or not the shipped page still has the same ids. That is not
 * hypothetical: `#pageNote` and `#openEpub` are both optional in `collect`, so
 * a page missing either would mount cleanly, do nothing, and fail no test.
 */
describe('the popup page and this file agree', () => {
  it('ships every id the tests above pretend it has', () => {
    const page = readFileSync(
      resolve(process.cwd(), 'src/entrypoints/popup/index.html'),
      'utf8',
    );
    const ids = [...MARKUP.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    const missing = ids.filter((id) => !page.includes(`id="${String(id)}"`));
    expect(missing).toEqual([]);
  });
});
