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
import { resolveSourceUrl } from '../core/capture';
import { captureNote, type CaptureConfig } from './capture';
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
 * The panel is injected into arbitrary pages, so it cannot assume a white host:
 * a hardcoded light sheet is blinding on a dark site or dark PDF viewer.
 * Contrast-checked both ways (dim text >= 4.5:1 on its own background).
 */
function palette(): { bg: string; fg: string; dim: string; rule: string } {
  const dark =
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  return dark
    ? { bg: '#1f1f1f', fg: '#e8e8e8', dim: '#9aa0aa', rule: '#3a3a3a' }
    : { bg: '#fff', fg: '#111', dim: '#6b7280', rule: '#e5e7eb' };
}

export interface SelectionSettings {
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

  function removeIcon(): void {
    icon?.remove();
    icon = null;
  }

  function removePanel(): void {
    activePort?.disconnect();
    activePort = null;
    window.clearTimeout(slowHintTimer);
    panel?.remove();
    panel = null;
  }

  function showIcon(rect: DOMRect, text: string): void {
    removeIcon();
    // A button, not a div: keyboard users select with the keyboard too, and a
    // div with a mousedown handler is unreachable for them.
    const el = document.createElement('button');
    el.id = ICON_ID;
    el.type = 'button';
    el.textContent = '文';
    el.setAttribute('aria-label', 'Translate selection');
    el.style.cssText = [
      'position:fixed',
      `top:${rect.bottom + 6}px`,
      `left:${rect.left}px`,
      `z-index:${Z}`,
      'width:28px',
      'height:28px',
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

    const skin = palette();
    el.style.cssText = [
      'position:fixed',
      vertical,
      horizontal,
      `z-index:${Z}`,
      // min-width used to win over max-width below ~400px of viewport and push
      // the panel off-screen; clamp it to the same 90vw ceiling.
      `min-width:min(${PANEL_MIN_WIDTH}px,90vw)`,
      'max-width:min(600px,90vw)',
      'max-height:80vh',
      'overflow:auto',
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
    content.style.cssText = 'white-space:pre-wrap;word-break:break-word';

    el.append(close, content);
    document.body.appendChild(el);
    panel = el;
    if (focusOnOpen) el.focus();
    return content;
  }

  function setPanelText(content: HTMLDivElement, text: string): void {
    content.textContent = text;
  }

  function appendChunk(content: HTMLDivElement, chunk: string): void {
    content.appendChild(document.createTextNode(chunk));
    if (panel) panel.scrollTop = panel.scrollHeight;
  }

  async function translate(
    text: string,
    rect: DOMRect,
    viaKeyboard = false,
  ): Promise<void> {
    removeIcon();
    const settings = await options.getSettings();
    const content = showPanel(rect, viaKeyboard);

    // Same-language selection: show it verbatim, no API round-trip.
    if (shouldBypassAI(text, settings.targetLang)) {
      setPanelText(content, text);
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
            `Translating… still waiting on ${settings.modelId} — the first request after a restart loads the model into memory.`,
          );
        }
      }, SLOW_HINT_MS);

      activePort?.disconnect();
      const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
      activePort = port;

      const close = (): void => {
        port.disconnect();
        if (activePort === port) activePort = null;
      };

      port.onMessage.addListener((res: StreamResponse) => {
        window.clearTimeout(slowHintTimer);
        if (res.status === 'streaming') {
          if (firstChunk) {
            setPanelText(content, '');
            firstChunk = false;
          }
          full += res.chunk;
          appendChunk(content, res.chunk);
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

      const skin = palette();
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

      const hint = document.createElement('span');
      hint.style.cssText = `font-size:12px;color:${skin.dim}`;

      bar.append(btn, hint);
      host.appendChild(bar);

      // Guard our own presses from the document-level mousedown teardown.
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
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
            hint.textContent =
              outcome.method === 'clipboard'
                ? 'Copied — paste into Obsidian'
                : 'Saved ✓';
          } else {
            hint.textContent = 'Save failed';
            btn.disabled = false;
          }
        });
      });
    }
  }

  function onMouseUp(event: MouseEvent): void {
    // Ignore clicks originating inside our own UI.
    const target = event.target as Node | null;
    if (target && (icon?.contains(target) || panel?.contains(target))) return;

    // Let the selection settle (PDF text layers lag a frame).
    window.setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (
        text.length > 1 &&
        text.length < 5000 &&
        selection &&
        selection.rangeCount > 0
      ) {
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        lastRect = rect;
        showIcon(rect, text);
      } else {
        removeIcon();
      }
    }, 50);
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

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);

  return () => {
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    removeIcon();
    removePanel();
    void lastRect;
  };
}
