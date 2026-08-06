// @vitest-environment jsdom
/**
 * The popup is the only surface a user visits before anything works, so it is
 * the only place a broken setup can be reported before it costs a translation.
 * These tests drive it against a stubbed probe, so every failure mode a first
 * run can hit — server down, origin refused, model not pulled — is a test
 * rather than a server someone has to misconfigure by hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountPopup, type PopupDeps } from './popup';
import type { ConnectionProbe } from '../core/diagnostics';

const MARKUP = `
  <button id="translatePage" type="button">Translate this page</button>
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
    <input id="obsidianVault" type="text" />
    <input id="obsidianFolder" type="text" />
    <input id="enrichOnCapture" type="checkbox" />
    <button id="saveBtn" type="submit">Save</button>
    <div id="status"></div>
  </form>
`;

let stored: Record<string, unknown>;
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

    document.getElementById('translatePage')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
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
