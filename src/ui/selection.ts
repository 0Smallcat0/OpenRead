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
  /** PDF viewer tags its close button so its overlay CSS can target it. */
  closeButtonClass?: string;
}

/**
 * Mount the selection translator on the current document. Returns a disposer
 * that removes listeners and any injected DOM.
 */
export function mountSelectionTranslator(
  options: SelectionUIOptions,
): () => void {
  let icon: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let activePort: chrome.runtime.Port | null = null;
  let lastRect: DOMRect | null = null;

  function removeIcon(): void {
    icon?.remove();
    icon = null;
  }

  function removePanel(): void {
    activePort?.disconnect();
    activePort = null;
    panel?.remove();
    panel = null;
  }

  function showIcon(rect: DOMRect, text: string): void {
    removeIcon();
    const el = document.createElement('div');
    el.id = ICON_ID;
    el.textContent = '文';
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
    ].join(';');
    // mousedown (not click) so we act before the selection is cleared.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastRect = rect;
      void translate(text, rect);
    });
    document.body.appendChild(el);
    icon = el;
  }

  function showPanel(rect: DOMRect): HTMLDivElement {
    removePanel();
    const el = document.createElement('div');
    el.id = PANEL_ID;

    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - rect.bottom;
    const openUpward = spaceBelow < 300 && rect.top > spaceBelow;

    const vertical = openUpward
      ? `bottom:${viewportHeight - rect.top + 6}px`
      : `top:${rect.bottom + 6}px`;
    const horizontal =
      rect.left + 320 > viewportWidth ? 'right:20px' : `left:${rect.left}px`;

    el.style.cssText = [
      'position:fixed',
      vertical,
      horizontal,
      `z-index:${Z}`,
      'min-width:400px',
      'max-width:min(600px,90vw)',
      'max-height:80vh',
      'overflow:auto',
      'background:#fff',
      'color:#111',
      'padding:14px 16px',
      'border-radius:10px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.18)',
      'font-size:15px',
      'line-height:1.6',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';');

    const close = document.createElement('div');
    if (options.closeButtonClass) close.className = options.closeButtonClass;
    close.textContent = '×';
    close.style.cssText =
      'position:absolute;top:6px;right:10px;cursor:pointer;font-size:18px;color:#888;user-select:none';
    close.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removePanel();
    });

    const content = document.createElement('div');
    content.className = CONTENT_CLASS;
    content.style.cssText = 'white-space:pre-wrap;word-break:break-word';

    el.append(close, content);
    document.body.appendChild(el);
    panel = el;
    return content;
  }

  function setPanelText(content: HTMLDivElement, text: string): void {
    content.textContent = text;
  }

  function appendChunk(content: HTMLDivElement, chunk: string): void {
    content.appendChild(document.createTextNode(chunk));
    if (panel) panel.scrollTop = panel.scrollHeight;
  }

  async function translate(text: string, rect: DOMRect): Promise<void> {
    removeIcon();
    const settings = await options.getSettings();
    const content = showPanel(rect);

    // Same-language selection: show it verbatim, no API round-trip.
    if (shouldBypassAI(text, settings.targetLang)) {
      setPanelText(content, text);
      mountCaptureButton(text, settings);
      return;
    }

    setPanelText(content, 'Translating…');
    let firstChunk = true;
    let full = '';

    activePort?.disconnect();
    const port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    activePort = port;

    port.onMessage.addListener((res: StreamResponse) => {
      if (res.status === 'streaming') {
        if (firstChunk) {
          setPanelText(content, '');
          firstChunk = false;
        }
        full += res.chunk;
        appendChunk(content, res.chunk);
      } else if (res.status === 'error') {
        setPanelText(content, `⚠️ ${res.message}`);
        port.disconnect();
        if (activePort === port) activePort = null;
      } else {
        port.disconnect();
        if (activePort === port) activePort = null;
        if (full.trim()) mountCaptureButton(full, settings);
      }
    });

    const message: StartStreamMessage = {
      type: 'START_STREAM',
      text,
      targetLang: settings.targetLang,
      model: settings.modelId,
      retryCount: 0,
    };
    port.postMessage(message);

    // Append a one-tap "save to Obsidian" control once a translation is ready.
    // Hoisted, so the same-language branch above can call it too.
    function mountCaptureButton(
      finalText: string,
      config: SelectionSettings,
    ): void {
      if (!panel || panel.querySelector('.oit-capture-bar')) return;
      const host = panel;

      const bar = document.createElement('div');
      bar.className = 'oit-capture-bar';
      bar.style.cssText =
        'margin-top:12px;padding-top:10px;border-top:1px solid #eee;' +
        'display:flex;align-items:center;gap:8px';

      const btn = document.createElement('button');
      btn.textContent = '＋ 儲存到 Obsidian';
      btn.style.cssText = [
        'appearance:none',
        'border:0',
        'cursor:pointer',
        'font-size:13px',
        'padding:6px 10px',
        'border-radius:6px',
        'background:#3b82f6',
        'color:#fff',
        'font-family:inherit',
      ].join(';');

      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:12px;color:#888';

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
        hint.textContent = config.enrichOnCapture ? '整理中…' : '儲存中…';

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
                ? '已複製，貼到 Obsidian'
                : '已儲存 ✓';
          } else {
            hint.textContent = '儲存失敗';
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

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);

  return () => {
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    removeIcon();
    removePanel();
    void lastRect;
  };
}
