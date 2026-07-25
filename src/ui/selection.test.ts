// @vitest-environment jsdom
/**
 * The selection controller is the only part of the product the user actually
 * touches, and until now it was the largest untested surface in the repo. These
 * tests drive it the way a page does — real DOM, a fake `chrome.runtime` port —
 * and assert on what the panel would show, not on internals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountSelectionTranslator } from './selection';
import { STREAM_PORT_NAME, type StreamResponse } from '../messaging';

const SETTINGS = {
  modelId: 'qwen3:latest',
  targetLang: 'Traditional Chinese',
  obsidianVault: '',
  obsidianFolder: 'OpenRead',
  enrichOnCapture: false,
};

/** A stand-in for the background broker: records what was sent, replays what we tell it to. */
class FakePort {
  readonly posted: unknown[] = [];
  disconnected = false;
  private listeners: ((res: StreamResponse) => void)[] = [];

  onMessage = {
    addListener: (fn: (res: StreamResponse) => void) => {
      this.listeners.push(fn);
    },
  };

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Push a broker response to the controller. */
  emit(res: StreamResponse): void {
    for (const fn of this.listeners) fn(res);
  }
}

let ports: FakePort[] = [];
let teardown: (() => void) | undefined;

const RECT = {
  top: 100,
  bottom: 120,
  left: 40,
  right: 300,
  width: 260,
  height: 20,
} as DOMRect;

/** Pretend the user selected `text`; the controller shows the icon a frame later. */
async function select(text: string): Promise<HTMLElement> {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => ({ getBoundingClientRect: () => RECT }),
  } as unknown as Selection);

  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  // onMouseUp defers by 50 ms so a PDF text layer can settle.
  await new Promise((r) => setTimeout(r, 70));
  const icon = document.getElementById('oit-translate-icon');
  if (!icon) throw new Error('the 文 icon never appeared');
  return icon;
}

/** Select `text` and click the 文 icon. */
async function selectAndTranslate(text: string): Promise<void> {
  const icon = await select(text);
  icon.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await settle();
}

/** Text currently rendered in the panel. */
function panelText(): string {
  const panel = document.getElementById('oit-translate-panel');
  return panel?.querySelector('.content-div')?.textContent ?? '';
}

/** Let the controller's awaited `getSettings()` resolve. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  ports = [];
  vi.stubGlobal('chrome', {
    runtime: {
      connect: (info: { name: string }) => {
        expect(info.name).toBe(STREAM_PORT_NAME);
        const port = new FakePort();
        ports.push(port);
        return port;
      },
    },
  });
  teardown = mountSelectionTranslator({
    getSettings: () => Promise.resolve(SETTINGS),
  });
});

afterEach(() => {
  teardown?.();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('streaming a translation', () => {
  it('replaces the placeholder with the streamed text', async () => {
    await selectAndTranslate('Hello, world!');
    expect(panelText()).toBe('Translating…');

    ports[0]?.emit({ status: 'streaming', chunk: '你好，' });
    ports[0]?.emit({ status: 'streaming', chunk: '世界！' });
    ports[0]?.emit({ status: 'done' });

    expect(panelText()).toBe('你好，世界！');
    expect(ports).toHaveLength(1);
  });

  it('shows a transport error and does not retry it', async () => {
    // Retrying "model not found" or a timeout only doubles the wait — the
    // message is already actionable.
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'error', message: 'Ollama 404: model not found' });

    expect(panelText()).toContain('Ollama 404: model not found');
    expect(ports).toHaveLength(1);
  });
});

describe('a generation that produces nothing', () => {
  it('retries once instead of leaving the panel on "Translating…"', async () => {
    // The benchmark caught reasoning models spending a whole generation on
    // hidden thinking. No chunk ever arrives, so the placeholder was never
    // replaced and the panel looked frozen.
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'done' });

    expect(ports).toHaveLength(2);
    expect(panelText()).toContain('trying again');
    expect(
      (ports[1]?.posted[0] as { retryCount?: number } | undefined)?.retryCount,
    ).toBe(1);
  });

  it('treats whitespace-only output as empty', async () => {
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'streaming', chunk: '   \n ' });
    ports[0]?.emit({ status: 'done' });

    expect(ports).toHaveLength(2);
  });

  it('reports a clear failure once the retry is also empty', async () => {
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'done' });
    ports[1]?.emit({ status: 'done' });

    expect(ports).toHaveLength(2);
    expect(panelText()).toContain('returned nothing, twice');
    expect(panelText()).toContain('qwen3:latest');
  });

  it('keeps a successful retry', async () => {
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'done' });
    ports[1]?.emit({ status: 'streaming', chunk: '你好' });
    ports[1]?.emit({ status: 'done' });

    expect(panelText()).toBe('你好');
  });
});

describe('same-language selection', () => {
  it('shows the text verbatim without opening a port', async () => {
    await selectAndTranslate('這是一段已經是繁體中文的內容。');

    expect(panelText()).toBe('這是一段已經是繁體中文的內容。');
    expect(ports).toHaveLength(0);
  });
});

describe('dismissing the panel', () => {
  it('closes on Escape', async () => {
    await selectAndTranslate('Hello, world!');
    expect(document.getElementById('oit-translate-panel')).not.toBeNull();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );

    expect(document.getElementById('oit-translate-panel')).toBeNull();
  });

  it('closes on the close button', async () => {
    await selectAndTranslate('Hello, world!');
    const close = document
      .getElementById('oit-translate-panel')
      ?.querySelector('button');
    close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.getElementById('oit-translate-panel')).toBeNull();
  });
});

describe('keyboard access', () => {
  it('exposes the trigger as a named button', async () => {
    const icon = await select('Hello, world!');

    expect(icon.tagName).toBe('BUTTON');
    expect(icon.getAttribute('aria-label')).toBe('Translate selection');
  });

  it('translates on Enter, and moves focus into the panel', async () => {
    const icon = await select('Hello, world!');
    icon.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();

    const panel = document.getElementById('oit-translate-panel');
    expect(panel).not.toBeNull();
    expect(document.activeElement).toBe(panel);
  });
});

describe('the panel is announced to assistive tech', () => {
  it('is a named dialog whose content is a live region', async () => {
    await selectAndTranslate('Hello, world!');
    const panel = document.getElementById('oit-translate-panel');

    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-label')).toBe('Translation');
    expect(
      panel?.querySelector('.content-div')?.getAttribute('aria-live'),
    ).toBe('polite');
  });
});
