/**
 * Capture orchestrator (UI shell). Runs in the content-script world where the
 * user gesture lives, so it can open an `obsidian://` URI directly and fall
 * back to the clipboard for notes too large for a URL. Optional enrichment is
 * delegated to the background worker — the only context allowed to reach the
 * local Ollama server without tripping mixed-content / CORS.
 *
 * All formatting is pure and lives in `core/capture`; this file only owns the
 * side effects (message round-trip, navigation, clipboard).
 */
import {
  buildMarkdown,
  buildObsidianUri,
  captureFilename,
  applyEnrichment,
} from '../core/capture';
import type { CaptureNote } from '../core/types';
import type { EnrichCaptureMessage, EnrichCaptureResponse } from '../messaging';

export interface CaptureConfig {
  vault: string;
  folder: string;
  enrich: boolean;
  model: string;
  targetLang: string;
}

export type CaptureOutcome =
  | { ok: true; method: 'obsidian' | 'clipboard' }
  | { ok: false; reason: string };

/**
 * Conservative URL length cap. OS protocol handlers truncate very long URLs
 * (Windows' `ShellExecute` in particular), so above this we copy the note to
 * the clipboard instead of silently losing content.
 */
const URI_LIMIT = 8000;

async function requestEnrichment(text: string, config: CaptureConfig) {
  try {
    const message: EnrichCaptureMessage = {
      type: 'ENRICH_CAPTURE',
      text: text.slice(0, 4000),
      targetLang: config.targetLang,
      model: config.model,
    };
    const res = (await chrome.runtime.sendMessage(message)) as
      EnrichCaptureResponse | undefined;
    return res?.result ?? null;
  } catch {
    return null;
  }
}

function openUri(uri: string): void {
  const a = document.createElement('a');
  a.href = uri;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the execCommand path (non-secure contexts / no gesture).
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Enrich (optional) → build the note → write it to Obsidian, or copy to the
 * clipboard when the note is too large for a protocol-handler URL.
 */
export async function captureNote(
  base: CaptureNote,
  config: CaptureConfig,
): Promise<CaptureOutcome> {
  let note = base;
  if (config.enrich) {
    const enrichment = await requestEnrichment(base.original, config);
    if (enrichment) note = applyEnrichment(base, enrichment);
  }

  const content = buildMarkdown(note);
  const uri = buildObsidianUri({
    vault: config.vault || undefined,
    folder: config.folder || undefined,
    filename: captureFilename(note),
    content,
  });

  if (uri.length <= URI_LIMIT) {
    openUri(uri);
    return { ok: true, method: 'obsidian' };
  }
  const copied = await copyToClipboard(content);
  return copied
    ? { ok: true, method: 'clipboard' }
    : { ok: false, reason: 'copy-failed' };
}
