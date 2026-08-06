/**
 * Selection-to-translate UI controller. This is the single source of truth for
 * the on-page translate experience, shared by BOTH the web content script and
 * the PDF viewer script — collapsing v1's ~90% copy-paste between content.js
 * and pdf-integration.js into one module.
 *
 * Flow: user selects text -> a small "文" icon appears by the selection ->
 * clicking it opens a panel and streams the translation in over the
 * `stream-translate` port. Same-language selections short-circuit with zero
 * network calls via the pure `shouldBypassAI` check.
 */
import { shouldBypassAI } from '../core/language';
import { toBcp47 } from '../core/bcp47';
import { resolveSourceUrl } from '../core/capture';
import { captureNote, copyToClipboard, type CaptureConfig } from './capture';
import type { CaptureNote } from '../core/types';
import {
  STREAM_PORT_NAME,
  type StartStreamMessage,
  type StreamResponse,
} from '../messaging';

const ICON_ID = 'oit-translate-icon';
const PANEL_ID = 'oit-translate-panel';
const CONTENT_CLASS = 'content-div';
const Z = '2147483647';
/** Single source for the panel's narrowest width — the right-edge test used to
 *  hardcode 320 against a 400px panel, so a selection near the right margin was
 *  judged to fit and then overflowed. */
const PANEL_MIN_WIDTH = 400;
/** How long "Translating…" may stand alone before it explains itself. */
const SLOW_HINT_MS = 4000;
/** Streaming attempts before an empty generation is reported as a failure. */
const MAX_ATTEMPTS = 2;
/**
 * Longest selection actually sent to the model. 4,700 characters already takes
 * ~21 s on the benchmark rig, so a whole-page selection is not something to run
 * silently. Beyond this the panel translates the leading passage and says so —
 * the old behaviour was for the 文 icon simply never to appear, which reads as
 * the extension being broken rather than as a limit.
 */
const MAX_TRANSLATE_CHARS = 5000;
/** Beyond this a "selection" is a stray Ctrl-A, not something to read. */
const MAX_SELECTION_CHARS = 50000;

/** Gap kept between the panel and the edge of the window. */
const PANEL_VIEWPORT_MARGIN = 8;

/** The 文 icon is a fixed 28px square with a small gap from the selection. */
const ICON_SIZE = 28;
const ICON_GAP = 6;

/**
 * Where the 文 icon goes.
 *
 * Beside the end of the selection, not under it. Under it is where the next
 * line of text is, and the icon swallows the mousedown that would have started
 * a selection there — reported as the PDF viewer being impossible to select in.
 * Measured on a five-line PDF: line boxes at y 92, 122, 152 with a height of
 * 20, so the ten pixels between lines could never hold a 28px button. Dragging
 * line one put the icon at 119–147, and dragging line two afterwards selected
 * nothing at all. Web pages hide the problem behind paragraph margins rather
 * than avoiding it.
 *
 * Falls back to the old placement when there is no room to the right, which is
 * a full-width selection running to the window edge — and there, at least, the
 * line below is usually the same paragraph the user just finished with.
 */
export function iconPosition(
  rect: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const clampTop = (value: number): number =>
    Math.min(Math.max(value, 0), Math.max(0, viewport.height - ICON_SIZE));

  const beside = rect.right + ICON_GAP;
  if (beside + ICON_SIZE <= viewport.width) {
    return { left: beside, top: clampTop(rect.bottom - ICON_SIZE) };
  }
  // No room after the text: put it before the start of the same line rather
  // than under it, because under it is the next line.
  const before = rect.left - ICON_GAP - ICON_SIZE;
  if (before >= 0) {
    return { left: before, top: clampTop(rect.bottom - ICON_SIZE) };
  }
  return {
    left: Math.max(0, Math.min(rect.left, viewport.width - ICON_SIZE)),
    top: clampTop(rect.bottom + ICON_GAP),
  };
}

/**
 * The line the selection ends on, which is where the icon belongs.
 *
 * A multi-line selection's bounding box is the union of its lines, so its
 * right edge is the *widest* line and its bottom is the *last* one — a corner
 * that need not be near either. Measured on a six-line paragraph in a PDF: the
 * union was 218..942 while the last line ended at 798, and the icon landed at
 * x 948 on top of an entirely different line of text, nowhere near where the
 * drag had finished.
 *
 * `getClientRects()` gives one rectangle per line fragment, in document order,
 * so the last of them is the end of the selection.
 */
export function selectionAnchor(range: Range): DOMRect {
  // Guarded: not every host gives a Range the full interface, and an icon in
  // a slightly wrong place beats a selection handler that throws.
  const rects =
    typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects()).filter(
          (rect) => rect.width > 0 || rect.height > 0,
        )
      : [];
  return rects[rects.length - 1] ?? range.getBoundingClientRect();
}

/**
 * Where the panel has to sit so all of it is on screen.
 *
 * The panel is placed before it has a height — the up-or-down choice tests a
 * fixed 300px of space below the selection, which is unrelated to how tall this
 * particular panel turns out to be. A long selection therefore opened downward
 * into a box that ran off the bottom of the window, and `position: fixed` means
 * no amount of scrolling brings it back. Measured on a 975-character selection
 * in a 703px viewport: the panel occupied 442–1005, putting **Save to Obsidian**
 * at 961–990, three hundred pixels below the fold and not hit-testable.
 *
 * So the placement is corrected once the real height is known. Pure, because a
 * layout bug is exactly the kind jsdom cannot see: the arithmetic is pinned
 * here and the wiring is checked in a real browser.
 */
export function clampPanelTop(
  top: number,
  height: number,
  viewportHeight: number,
  margin: number = PANEL_VIEWPORT_MARGIN,
): number {
  const lowest = viewportHeight - margin - height;
  // Taller than the window: no position shows all of it, and the top is the
  // half worth showing — it holds the translation and the close button.
  if (lowest <= margin) return margin;
  return Math.min(Math.max(top, margin), lowest);
}

/** Move `el` so all of it is on screen, if it is not already. */
function fitPanelToViewport(el: HTMLElement): void {
  const box = el.getBoundingClientRect();
  const top = clampPanelTop(box.top, box.height, window.innerHeight);
  if (Math.abs(top - box.top) <= 0.5) return;
  // `bottom` has to go: an upward-opened panel is anchored by it, and a fixed
  // box with both `top` and `bottom` set stretches to span them.
  el.style.bottom = 'auto';
  el.style.top = `${String(top)}px`;
}

/** Relative luminance of a CSS colour, or null if it is transparent. */
function luminanceOf(color: string): number | null {
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  if (parts.length > 3 && Number(parts[3]) === 0) return null; // fully transparent
  const [r, g, b] = parts.slice(0, 3).map((value) => {
    const channel = Number(value) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/**
 * Is the page the panel is about to sit on a dark one?
 *
 * Asking `prefers-color-scheme` — which is what this used to do — answers a
 * different question: the user's *system* preference. Most sites are light-only
 * whatever that preference says, so a dark OS setting put a dark panel on a
 * light page, which is exactly the mismatch the palette exists to avoid. Read
 * the background actually painted behind the selection instead, and fall back
 * to the media query only when everything in the chain is transparent.
 */
function pageIsDark(at: DOMRect | null): boolean {
  let hit: Element | null = null;
  try {
    // Not universally available (jsdom has no layout, so it throws), and a
    // panel that fails to open is a far worse outcome than a mistuned palette.
    if (at) hit = document.elementFromPoint(at.left + 1, at.top + 1);
  } catch {
    hit = null;
  }
  const seed = hit ?? document.body;
  for (let el: Element | null = seed; el; el = el.parentElement) {
    const lum = luminanceOf(getComputedStyle(el).backgroundColor);
    if (lum !== null) return lum < 0.4;
  }
  const root = luminanceOf(
    getComputedStyle(document.documentElement).backgroundColor,
  );
  if (root !== null) return root < 0.4;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/**
 * The panel is injected into arbitrary pages, so it cannot assume a white host:
 * a hardcoded light sheet is blinding on a dark site or dark PDF viewer.
 * Contrast-checked both ways (dim text >= 4.5:1 on its own background).
 */
function palette(at: DOMRect | null = null): {
  bg: string;
  fg: string;
  dim: string;
  rule: string;
} {
  return pageIsDark(at)
    ? { bg: '#1f1f1f', fg: '#e8e8e8', dim: '#9aa0aa', rule: '#3a3a3a' }
    : { bg: '#fff', fg: '#111', dim: '#6b7280', rule: '#e5e7eb' };
}

export interface SelectionSettings {
  /**
   * Which engine will answer. The panel needs it only to say true things while
   * waiting: the built-in translator has no model to name, and telling someone
   * running on Chrome's own translator that we are "waiting on qwen3:latest"
   * names a thing they never installed.
   */
  engine?: 'builtin' | 'ollama';
  modelId: string;
  targetLang: string;
  /** Obsidian vault to capture into; empty = the user's current/last vault. */
  obsidianVault: string;
  /** Vault-relative folder for captures. */
  obsidianFolder: string;
  /** Run a local-model enrichment pass when capturing. */
  enrichOnCapture: boolean;
}

export interface SelectionUIOptions {
  /** Read the current model + target language at translate time. */
  getSettings: () => Promise<SelectionSettings>;
}

/**
 * Mount the selection translator on the current document. Returns a disposer
 * that removes listeners and any injected DOM.
 */
export function mountSelectionTranslator(
  options: SelectionUIOptions,
): () => void {
  let icon: HTMLButtonElement | null = null;
  let panel: HTMLDivElement | null = null;
  let activePort: chrome.runtime.Port | null = null;
  let lastRect: DOMRect | null = null;
  let slowHintTimer: number | undefined;
  /** Watches the open panel so it can be re-fitted as the translation fills it. */
  let panelResize: ResizeObserver | null = null;
  /**
   * Set when the 文 button starts a translation on mousedown. The matching
   * mouseup still reaches the document, where it used to be read as "the user
   * finished selecting" — the selection is of course still there, so the icon
   * reappeared on top of the panel it had just opened. Only visible with a real
   * press/release pair; a synthesised mousedown never produced one.
   */
  let ignoreNextMouseUp = false;

  function removeIcon(): void {
    icon?.remove();
    icon = null;
  }

  function removePanel(): void {
    activePort?.disconnect();
    activePort = null;
    window.clearTimeout(slowHintTimer);
    panelResize?.disconnect();
    panelResize = null;
    panel?.remove();
    panel = null;
  }

  function showIcon(anchor: DOMRect, text: string, rect: DOMRect): void {
    removeIcon();
    // A button, not a div: keyboard users select with the keyboard too, and a
    // div with a mousedown handler is unreachable for them.
    const el = document.createElement('button');
    el.id = ICON_ID;
    el.type = 'button';
    el.textContent = '文';
    el.setAttribute('aria-label', 'Translate selection');
    const place = iconPosition(anchor, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    el.style.cssText = [
      'position:fixed',
      `top:${place.top}px`,
      `left:${place.left}px`,
      `z-index:${Z}`,
      // Tied to ICON_SIZE, which the placement above measures against.
      `width:${String(ICON_SIZE)}px`,
      `height:${String(ICON_SIZE)}px`,
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:#3b82f6',
      'color:#fff',
      'font-size:14px',
      'border-radius:6px',
      'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
      'user-select:none',
      'border:0',
      'padding:0',
      'font-family:inherit',
    ].join(';');
    // mousedown (not click) so we act before the selection is cleared.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ignoreNextMouseUp = true;
      lastRect = rect;
      void translate(text, rect);
    });
    // ...but a keyboard press never clears the selection, so Enter/Space works
    // through the normal keydown path.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      lastRect = rect;
      void translate(text, rect, true);
    });
    document.body.appendChild(el);
    icon = el;
  }

  /** `focusOnOpen` is set only for keyboard activation: translate() removes the
   *  icon first, so the element the user was focused on disappears and focus
   *  falls back to <body> unless the panel takes it. Doing this on a mouse
   *  click would steal focus from the page for no reason. */
  function showPanel(rect: DOMRect, focusOnOpen = false): HTMLDivElement {
    removePanel();
    const el = document.createElement('div');
    el.id = PANEL_ID;
    // -1: focusable by script (see focusOnOpen) but never a Tab stop of its own.
    el.tabIndex = -1;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Translation');

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - rect.bottom;
    const openUpward = spaceBelow < 300 && rect.top > spaceBelow;

    const vertical = openUpward
      ? `bottom:${viewportHeight - rect.top + 6}px`
      : `top:${rect.bottom + 6}px`;
    const horizontal =
      rect.left + PANEL_MIN_WIDTH > viewportWidth
        ? 'right:20px'
        : `left:${rect.left}px`;

    // Sampled at the selection, so the panel matches the page it lands on.
    const skin = palette(rect);
    el.style.cssText = [
      'position:fixed',
      vertical,
      horizontal,
      `z-index:${Z}`,
      // Without this the widths below are content-box, so the 30px of
      // horizontal padding is added on top of them: a 90vw panel measured
      // 370px in a 375px viewport and hung 14px off the left edge once the
      // right-edge branch pushed it back. Caught in a real layout engine —
      // jsdom computes no geometry, so no unit test could have seen it.
      'box-sizing:border-box',
      // min-width used to win over max-width below ~400px of viewport and push
      // the panel off-screen; clamp it to the same 90vw ceiling.
      `min-width:min(${PANEL_MIN_WIDTH}px,90vw)`,
      'max-width:min(600px,90vw)',
      'max-height:80vh',
      // The panel itself does not scroll; its text does.
      //
      // It used to, and the close button is positioned against the panel, so
      // reading to the bottom of a long translation carried the × off the top
      // — measured at `top: -51` after scrolling to the end. Making the text
      // the scrolling part keeps the × and the buttons where the user left
      // them, which is what a dialog is supposed to do.
      'overflow:hidden',
      'display:flex',
      'flex-direction:column',
      `background:${skin.bg}`,
      `color:${skin.fg}`,
      'padding:14px 16px',
      'border-radius:10px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
      'font-size:15px',
      'line-height:1.6',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';');

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.style.cssText =
      'position:absolute;top:6px;right:10px;cursor:pointer;font-size:18px;' +
      // #888 was 3.54:1; the dim tone is contrast-checked for both schemes
      `color:${skin.dim};user-select:none;background:none;border:0;` +
      'padding:0;line-height:1;font-family:inherit';
    close.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removePanel();
    });
    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removePanel();
    });

    const content = document.createElement('div');
    content.className = CONTENT_CLASS;
    // The translation streams in chunk by chunk; without a live region a screen
    // reader never hears any of it.
    content.setAttribute('aria-live', 'polite');
    content.style.cssText =
      'white-space:pre-wrap;word-break:break-word;' +
      // The one part that scrolls, so the × above it and the buttons below it
      // stay put. `min-height:0` because a flex child will not shrink past its
      // content without it, which puts the overflow back on the panel.
      'overflow:auto;flex:1 1 auto;min-height:0;padding-right:14px';

    el.append(close, content);
    document.body.appendChild(el);

    // Fitting it once here would prove nothing: the panel is mounted empty and
    // is barely forty pixels tall, so of course it fits. The translation lands
    // afterwards, and a long one is what pushes the bottom of the box off the
    // screen — measured at 442-1005 in a 703px viewport, with Save to Obsidian
    // three hundred pixels below the fold. So watch it and re-fit as it grows,
    // which also covers the capture bar arriving at the end.
    fitPanelToViewport(el);
    if (typeof ResizeObserver !== 'undefined') {
      panelResize = new ResizeObserver(() => {
        fitPanelToViewport(el);
      });
      panelResize.observe(el);
    }

    panel = el;
    if (focusOnOpen) el.focus();
    return content;
  }

  /**
   * Write a status line: "Translating…", a download percentage, an error.
   *
   * All of them are English, so this also drops any `lang` a previous
   * translation left behind — a screen reader reading "Translating…" in a
   * Chinese voice is the same defect in the other direction.
   */
  function setPanelText(content: HTMLDivElement, text: string): void {
    content.removeAttribute('lang');
    content.textContent = text;
  }

  function appendChunk(content: HTMLDivElement, chunk: string): void {
    content.appendChild(document.createTextNode(chunk));
    // The text is what scrolls now, not the panel around it.
    content.scrollTop = content.scrollHeight;
  }

  /** A line above the translation explaining something about the request. */
  function mountNotice(host: HTMLDivElement, message: string): void {
    const skin = palette(lastRect);
    const notice = document.createElement('div');
    notice.className = 'oit-notice';
    notice.textContent = message;
    notice.style.cssText =
      `font-size:12px;color:${skin.dim};margin:0 0 8px;` +
      `padding-bottom:8px;border-bottom:1px solid ${skin.rule}`;
    host.prepend(notice);
  }

  async function translate(
    selected: string,
    rect: DOMRect,
    viaKeyboard = false,
  ): Promise<void> {
    removeIcon();
    const settings = await options.getSettings();
    const content = showPanel(rect, viaKeyboard);

    // Only the leading passage goes to the model, but say so rather than
    // quietly translating part of what the user highlighted.
    const text = selected.slice(0, MAX_TRANSLATE_CHARS);
    if (selected.length > MAX_TRANSLATE_CHARS && panel) {
      mountNotice(
        panel,
        `Selection is ${selected.length.toLocaleString()} characters — translating the first ${MAX_TRANSLATE_CHARS.toLocaleString()}.`,
      );
    }

    /**
     * The panel is a live region, which is the whole reason a screen reader
     * hears the translation at all — and it was handing it over with no
     * language marked, so Chinese came out read by an English voice. Marked
     * only while the translated text is on screen; `setPanelText` clears it
     * again for the English status lines.
     */
    const bcp47 = toBcp47(settings.targetLang);
    const markLanguage = (): void => {
      if (bcp47) content.lang = bcp47;
    };

    // Same-language selection: show it verbatim, no API round-trip. Still the
    // target language, so it is still marked as such.
    if (shouldBypassAI(text, settings.targetLang)) {
      setPanelText(content, text);
      markLanguage();
      mountCaptureButton(text, settings);
      return;
    }

    /**
     * One streaming attempt. A model that generates nothing is a real,
     * measured failure mode — the benchmark caught reasoning models spending
     * a whole generation on hidden thinking — and it used to surface as a
     * panel frozen on "Translating…" (no chunk ever arrives, so the
     * placeholder is never replaced) or as an empty box. `attempt` is passed
     * through as `retryCount`, which loosens the sampling temperature on the
     * second try. Only an empty result is retried: a transport error already
     * carries an actionable message, and retrying a timeout would just double
     * the wait.
     */
    const startAttempt = (attempt: number): void => {
      let firstChunk = true;
      let full = '';

      setPanelText(
        content,
        attempt === 0 ? 'Translating…' : 'Empty response — trying again…',
      );

      // A first request after the browser starts has to load the model into
      // VRAM — measured at ~12 s on the benchmark rig, and slower on a cold
      // disk. An unchanging "Translating…" through all of that reads as
      // broken, so say what the wait is for rather than leaving the user
      // guessing.
      window.clearTimeout(slowHintTimer);
      slowHintTimer = window.setTimeout(() => {
        if (firstChunk && panel) {
          setPanelText(
            content,
            settings.engine === 'ollama'
              ? `Translating… still waiting on ${settings.modelId} — the first request after a restart loads the model into memory.`
              : // The built-in engine's long wait is a language pack, not a
                // model load, and it is measured in minutes rather than
                // seconds: 145 s for Japanese, 219 s for Traditional Chinese
                // on a profile that had neither.
                'Translating… Chrome is fetching the language pack for this pair. That happens once, and takes a couple of minutes.',
          );
        }
      }, SLOW_HINT_MS);

      activePort?.disconnect();
      const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
      activePort = port;

      let settled = false;
      const close = (): void => {
        settled = true;
        port.disconnect();
        if (activePort === port) activePort = null;
      };

      /**
       * The worker going away has to end the wait, or nothing does.
       *
       * A Manifest V3 worker is terminated when it goes idle, and a
       * language-pack download is minutes of exactly that: no port traffic
       * while Chrome fetches, so the worker is reclaimed mid-request and the
       * port closes without a `done`. Whole-page translation has always
       * handled this; the panel did not, and sat on "Translating…" for ever.
       * Found on a real PDF, where the pack for the target had never been
       * fetched: the panel was still waiting long after the worker had gone.
       */
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        window.clearTimeout(slowHintTimer);
        if (activePort === port) activePort = null;
        if (!panel) return;
        setPanelText(
          content,
          full.trim()
            ? `${full.trim()}\n\n⚠️ The background worker stopped before this finished.`
            : '⚠️ The background worker stopped before the translation finished. Try again — a language pack it had already fetched is kept.',
        );
        if (full.trim()) markLanguage();
      });

      port.onMessage.addListener((res: StreamResponse) => {
        window.clearTimeout(slowHintTimer);
        if (res.status === 'streaming') {
          if (firstChunk) {
            setPanelText(content, '');
            markLanguage();
            firstChunk = false;
          }
          full += res.chunk;
          appendChunk(content, res.chunk);
        } else if (res.status === 'downloading') {
          // Chrome fetching a language pack. Around two minutes the first time
          // a language pair is used, and switching target language is how most
          // people meet it — silence here reads as a broken extension.
          setPanelText(
            content,
            `Downloading the language pack — ${String(
              Math.round(res.loaded * 100),
            )}%. This happens once per language.`,
          );
        } else if (res.status === 'error') {
          setPanelText(content, `⚠️ ${res.message}`);
          close();
        } else {
          close();
          if (full.trim()) {
            mountCaptureButton(full, settings);
          } else if (attempt + 1 < MAX_ATTEMPTS) {
            startAttempt(attempt + 1);
          } else {
            setPanelText(
              content,
              `⚠️ ${settings.modelId} returned nothing, twice. Try a shorter selection or a different model.`,
            );
          }
        }
      });

      const message: StartStreamMessage = {
        type: 'START_STREAM',
        text,
        targetLang: settings.targetLang,
        model: settings.modelId,
        retryCount: attempt,
        sourceLang: document.documentElement.lang || undefined,
      };
      port.postMessage(message);
    };

    startAttempt(0);

    // Append a one-tap "save to Obsidian" control once a translation is ready.
    // Hoisted, so the same-language branch above can call it too.
    function mountCaptureButton(
      finalText: string,
      config: SelectionSettings,
    ): void {
      if (!panel || panel.querySelector('.oit-capture-bar')) return;
      const host = panel;

      const skin = palette(lastRect);
      const bar = document.createElement('div');
      bar.className = 'oit-capture-bar';
      bar.style.cssText =
        `margin-top:12px;padding-top:10px;border-top:1px solid ${skin.rule};` +
        'display:flex;align-items:center;gap:8px';

      const btn = document.createElement('button');
      btn.type = 'button';
      // The rest of this UI (popup, "Translating…") is English; the capture
      // strings were the only Chinese left in the chrome.
      btn.textContent = '＋ Save to Obsidian';
      btn.style.cssText = [
        'appearance:none',
        'border:0',
        'cursor:pointer',
        'font-size:13px',
        'padding:6px 10px',
        'border-radius:6px',
        // #3b82f6 put white text at 3.68:1
        'background:#2563eb',
        'color:#fff',
        'font-family:inherit',
      ].join(';');

      /**
       * Copy, beside Save.
       *
       * The most common thing to do with a translation is put it somewhere,
       * and until now the only somewhere was an Obsidian vault. It also gives
       * the capture path an honest fallback: handing a URL to the OS protocol
       * handler produces no completion signal, so if Obsidian is not installed
       * the panel says "Sent" and nothing happens — and now there is a second
       * button right there that does work.
       */
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = '⧉ Copy';
      copy.style.cssText = [
        'appearance:none',
        'cursor:pointer',
        'font-size:13px',
        'padding:6px 10px',
        'border-radius:6px',
        'background:none',
        `color:${skin.fg}`,
        `border:1px solid ${skin.rule}`,
        'font-family:inherit',
      ].join(';');

      const hint = document.createElement('span');
      hint.style.cssText = `font-size:12px;color:${skin.dim}`;

      bar.append(btn, copy, hint);
      host.appendChild(bar);

      // Guard our own presses from the document-level mousedown teardown.
      for (const control of [btn, copy]) {
        control.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
      }

      copy.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const restore = (): void => {
          window.setTimeout(() => {
            copy.textContent = '⧉ Copy';
          }, 1500);
        };
        // Not `navigator.clipboard.writeText` directly: it is refused often
        // enough that the capture path already carries a fallback, and this
        // button was measured failing without one on a plain http page.
        void copyToClipboard(finalText).then(
          (ok) => {
            copy.textContent = ok ? '✓ Copied' : 'Copy failed';
            restore();
          },
          () => {
            copy.textContent = 'Copy failed';
            restore();
          },
        );
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        hint.textContent = config.enrichOnCapture ? 'Enriching…' : 'Saving…';

        const note: CaptureNote = {
          title: document.title,
          source: document.title,
          url: resolveSourceUrl(location.href),
          capturedAt: new Date().toISOString(),
          from: 'auto',
          to: config.targetLang,
          original: text,
          translation: finalText,
          tags: ['openread'],
          status: 'raw',
        };
        const captureConfig: CaptureConfig = {
          vault: config.obsidianVault,
          folder: config.obsidianFolder,
          enrich: config.enrichOnCapture,
          model: config.modelId,
          targetLang: config.targetLang,
        };

        void captureNote(note, captureConfig).then((outcome) => {
          if (outcome.ok) {
            // "Sent", not "Saved": handing a URL to the OS protocol handler
            // gives no completion signal back, so if Obsidian is not installed
            // — or declines the URL — nothing happens and the page is never
            // told. Claiming a save we cannot observe is the one thing worse
            // than saying less.
            hint.textContent =
              outcome.method === 'clipboard'
                ? 'Copied — paste into Obsidian'
                : 'Sent to Obsidian ↗';
          } else {
            hint.textContent = 'Save failed';
            btn.disabled = false;
          }
        });
      });
    }
  }

  /**
   * The current selection, if it is something worth offering to translate.
   *
   * Two rectangles, because they answer different questions. `rect` is the
   * whole selection, which is what the panel is placed against and what the
   * palette is sampled from. `anchor` is the line it ends on, which is where
   * the icon goes — see `selectionAnchor`.
   */
  function usableSelection(): {
    text: string;
    rect: DOMRect;
    anchor: DOMRect;
  } | null {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (
      text.length > 1 &&
      text.length < MAX_SELECTION_CHARS &&
      selection &&
      selection.rangeCount > 0
    ) {
      const range = selection.getRangeAt(0);
      return {
        text,
        rect: range.getBoundingClientRect(),
        anchor: selectionAnchor(range),
      };
    }
    return null;
  }

  /** Offer the 文 icon for whatever is selected now, or take it away. */
  function refreshIcon(): void {
    // Let the selection settle (PDF text layers lag a frame).
    window.setTimeout(() => {
      const found = usableSelection();
      if (found) {
        lastRect = found.rect;
        showIcon(found.anchor, found.text, found.rect);
      } else {
        removeIcon();
      }
    }, 50);
  }

  function onMouseUp(event: MouseEvent): void {
    if (ignoreNextMouseUp) {
      ignoreNextMouseUp = false;
      return;
    }
    // Ignore clicks originating inside our own UI.
    const target = event.target as Node | null;
    if (target && (icon?.contains(target) || panel?.contains(target))) return;
    refreshIcon();
  }

  /**
   * Text can be selected with the keyboard too — Shift with an arrow or
   * Home/End/PageUp/PageDown, or Ctrl+A — and none of that produces a mouseup.
   * Without this the icon simply never appeared for a keyboard user, which made
   * the button's own keyboard support unreachable.
   */
  function onKeyUp(event: KeyboardEvent): void {
    const selectionKey =
      (event.shiftKey &&
        /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/.test(
          event.key,
        )) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a');
    if (selectionKey) refreshIcon();
  }

  /** Translate what is selected right now — the toolbar-free entry point. */
  function translateCurrentSelection(): void {
    const found = usableSelection();
    if (!found) return;
    lastRect = found.rect;
    // Focus moves into the panel: the request came from the keyboard, so there
    // is no pointer to carry the user's attention there.
    void translate(found.text, found.rect, true);
  }

  function onMouseDown(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (target && (icon?.contains(target) || panel?.contains(target))) return;
    removeIcon();
    removePanel();
  }

  // Clicking outside was the only way to dismiss the panel, which leaves a
  // keyboard user stuck with it open.
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (!panel && !icon) return;
    removeIcon();
    removePanel();
  }

  /** The keyboard shortcut arrives from the background worker. */
  function onRuntimeMessage(message: unknown): void {
    if ((message as { type?: string } | null)?.type === 'TRANSLATE_SELECTION') {
      translateCurrentSelection();
    }
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  chrome.runtime?.onMessage?.addListener(onRuntimeMessage);

  return () => {
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    chrome.runtime?.onMessage?.removeListener(onRuntimeMessage);
    removeIcon();
    removePanel();
    void lastRect;
  };
}
