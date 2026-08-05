// @vitest-environment jsdom
/**
 * The selection controller is the only part of the product the user actually
 * touches, and until now it was the largest untested surface in the repo. These
 * tests drive it the way a page does — real DOM, a fake `chrome.runtime` port —
 * and assert on what the panel would show, not on internals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mountSelectionTranslator,
  clampPanelTop,
  iconPosition,
} from './selection';
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
/** Listeners the controller registered on chrome.runtime.onMessage. */
let runtimeListeners: ((message: unknown) => void)[] = [];

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
function panelContent(): HTMLElement | null {
  return (
    document
      .getElementById('oit-translate-panel')
      ?.querySelector<HTMLElement>('.content-div') ?? null
  );
}

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
  runtimeListeners = [];
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (fn: (message: unknown) => void) => {
          runtimeListeners.push(fn);
        },
        removeListener: (fn: (message: unknown) => void) => {
          runtimeListeners = runtimeListeners.filter((f) => f !== fn);
        },
      },
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

  it('does not bring the icon back on the mouseup that follows the click', async () => {
    // A real press/release pair: the mousedown opens the panel, and the mouseup
    // that follows still reaches the document. It used to be read as a fresh
    // selection, so the icon reappeared on top of the panel it had just opened.
    const icon = await select('Hello, world!');
    icon.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await settle();
    await new Promise((r) => setTimeout(r, 90));

    expect(document.getElementById('oit-translate-panel')).not.toBeNull();
    expect(document.getElementById('oit-translate-icon')).toBeNull();
  });

  it('shows a transport error and does not retry it', async () => {
    // Retrying "model not found" or a timeout only doubles the wait — the
    // message is already actionable.
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'error', message: 'Ollama 404: model not found' });

    expect(panelText()).toContain('Ollama 404: model not found');
    expect(ports).toHaveLength(1);
  });

  it('marks the translated text with the target language', async () => {
    // The panel is a live region, so a screen reader reads whatever lands in
    // it. Unmarked, it read Chinese in an English voice.
    await selectAndTranslate('Hello, world!');
    const content = panelContent();
    expect(content?.getAttribute('lang')).toBeNull();

    ports[0]?.emit({ status: 'streaming', chunk: '你好，世界！' });
    ports[0]?.emit({ status: 'done' });

    expect(content?.getAttribute('lang')).toBe('zh-Hant');
  });

  it('drops the language marking again for an English status line', async () => {
    await selectAndTranslate('Hello, world!');
    ports[0]?.emit({ status: 'streaming', chunk: '你好' });
    expect(panelContent()?.getAttribute('lang')).toBe('zh-Hant');

    ports[0]?.emit({ status: 'error', message: 'Ollama 404: model not found' });
    // Otherwise "Ollama 404: model not found" is announced in a Chinese voice.
    expect(panelContent()?.getAttribute('lang')).toBeNull();
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

describe('a selection longer than the model should be handed', () => {
  it('still offers the icon, instead of silently ignoring the selection', async () => {
    // The old guard hid the icon above 5,000 characters, so selecting a whole
    // page looked like the extension had stopped working.
    const icon = await select('word '.repeat(2000));

    expect(icon.tagName).toBe('BUTTON');
  });

  it('translates the leading passage and says how much it took', async () => {
    await selectAndTranslate('word '.repeat(2000)); // 10,000 characters

    const notice = document
      .getElementById('oit-translate-panel')
      ?.querySelector('.oit-notice')?.textContent;
    expect(notice).toContain('9,999 characters'); // trailing space trimmed
    expect(notice).toContain('first 5,000');

    const sent = ports[0]?.posted[0] as { text: string };
    expect(sent.text).toHaveLength(5000);
  });

  it('sizes the panel border-box so padding cannot push it off-screen', async () => {
    // jsdom computes no geometry, so this can only assert the declaration — but
    // its absence is exactly the bug: with content-box sizing the 30px of
    // horizontal padding lands on top of the 90vw cap, and a real browser put
    // the panel at left:-14px in a 375px viewport.
    await selectAndTranslate('Hello, world!');

    const style = document.getElementById('oit-translate-panel')?.style;
    expect(style?.boxSizing).toBe('border-box');
    expect(style?.minWidth).toBe('min(400px,90vw)');
    expect(style?.maxWidth).toBe('min(600px,90vw)');
  });

  it('says nothing when the whole selection fits', async () => {
    await selectAndTranslate('Hello, world!');

    expect(
      document
        .getElementById('oit-translate-panel')
        ?.querySelector('.oit-notice'),
    ).toBeNull();
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

describe('selecting without a mouse', () => {
  /** Select text the way Shift+Arrow does: no mouseup ever fires. */
  async function keyboardSelect(text: string): Promise<void> {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => text,
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => RECT }),
    } as unknown as Selection);
    document.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 70));
  }

  it('offers the icon after a Shift+Arrow selection', async () => {
    // Without this the icon only ever appeared on mouseup, so the button's own
    // keyboard support was unreachable for the people who needed it.
    await keyboardSelect('Hello, world!');

    expect(document.getElementById('oit-translate-icon')).not.toBeNull();
  });

  it('offers the icon after Ctrl+A', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'Hello, world!',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => RECT }),
    } as unknown as Selection);
    document.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 70));

    expect(document.getElementById('oit-translate-icon')).not.toBeNull();
  });

  it('ignores keys that cannot change the selection', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'Hello, world!',
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => RECT }),
    } as unknown as Selection);
    document.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 70));

    expect(document.getElementById('oit-translate-icon')).toBeNull();
  });

  it('translates the current selection on the keyboard shortcut', async () => {
    // The command lands as a runtime message from the background worker.
    await keyboardSelect('Hello, world!');
    runtimeListeners.forEach((fn) => fn({ type: 'TRANSLATE_SELECTION' }));
    await settle();

    expect(panelText()).toBe('Translating…');
    expect(ports).toHaveLength(1);
    expect(document.activeElement).toBe(
      document.getElementById('oit-translate-panel'),
    );
  });

  it('does nothing on the shortcut when nothing is selected', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
      rangeCount: 0,
    } as unknown as Selection);
    runtimeListeners.forEach((fn) => fn({ type: 'TRANSLATE_SELECTION' }));
    await settle();

    expect(document.getElementById('oit-translate-panel')).toBeNull();
    expect(ports).toHaveLength(0);
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

describe('keeping the panel inside the window', () => {
  // jsdom computes no geometry, so the placement itself is checked in a real
  // browser. What is pinned here is the arithmetic that browser run exposed:
  // a 975-character selection produced a panel occupying 442-1005 of a 703px
  // viewport, leaving Save to Obsidian 300px below the fold on a position:fixed
  // box that no scrolling can bring back.
  const VIEWPORT = 703;

  it('leaves a panel that already fits where it is', () => {
    expect(clampPanelTop(442, 127, VIEWPORT)).toBe(442);
  });

  it('lifts a panel whose bottom would fall off the screen', () => {
    // The measured case: 442 + 563 = 1005, past the 703px fold.
    expect(clampPanelTop(442, 563, VIEWPORT)).toBe(VIEWPORT - 8 - 563);
    expect(clampPanelTop(442, 563, VIEWPORT) + 563).toBeLessThanOrEqual(
      VIEWPORT - 8,
    );
  });

  it('pushes down a panel that opened above the top of the screen', () => {
    // The other direction, also measured: an upward-opening panel reached -189.
    expect(clampPanelTop(-189, 487, VIEWPORT)).toBe(8);
  });

  it('shows the top of a panel taller than the window', () => {
    // Nothing fits, and the top is the half worth showing — it carries the
    // translation and the close button.
    expect(clampPanelTop(300, 900, VIEWPORT)).toBe(8);
  });

  it('respects a caller-supplied margin', () => {
    expect(clampPanelTop(900, 100, VIEWPORT, 20)).toBe(VIEWPORT - 20 - 100);
  });
});

describe('where the 文 icon goes', () => {
  // Measured on a five-line PDF: line boxes at y 92, 122, 152, height 20. The
  // icon used to sit at `bottom + 6`, so translating line one put a 28px
  // button across 119-147 and line two (122-142) could not be selected at all
  // — its mousedown hit the icon, which preventDefaults it.
  const VIEWPORT = { width: 1000, height: 700 };
  const line = { left: 30, right: 480, top: 92, bottom: 112 };

  it('sits beside the end of the selection, clear of the next line', () => {
    const at = iconPosition(line, VIEWPORT);
    expect(at.left).toBe(486);
    // Level with the line it belongs to, and nowhere near 122-142.
    expect(at.top).toBe(84);
    expect(at.top + 28).toBeLessThanOrEqual(112);
  });

  it('does not overlap the line below, whatever the line spacing', () => {
    const next = { top: 122, bottom: 142 };
    const at = iconPosition(line, VIEWPORT);
    const overlapsVertically = at.top < next.bottom && at.top + 28 > next.top;
    const overlapsHorizontally = at.left < line.right;
    expect(overlapsVertically && overlapsHorizontally).toBe(false);
  });

  it('falls back below when a selection runs to the window edge', () => {
    const full = { left: 30, right: 995, top: 92, bottom: 112 };
    const at = iconPosition(full, VIEWPORT);
    expect(at.left).toBe(30);
    expect(at.top).toBe(118);
  });

  it('keeps the icon on screen for a selection at the bottom', () => {
    const at = iconPosition(
      { left: 30, right: 400, top: 690, bottom: 700 },
      VIEWPORT,
    );
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.top + 28).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('keeps the icon on screen for a selection at the very top', () => {
    const at = iconPosition(
      { left: 30, right: 400, top: 0, bottom: 10 },
      VIEWPORT,
    );
    expect(at.top).toBe(0);
  });
});
