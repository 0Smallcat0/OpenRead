import { mountPopup } from '../../ui/popup';
import { probeOllama } from '../../api/probe';
import type { PlatformOs } from '../../core/diagnostics';
import type { TranslatePageMessage } from '../../messaging';

/** Map Chrome's platform list onto the three shells that need different fixes. */
async function platformOs(): Promise<PlatformOs> {
  const { os } = await chrome.runtime.getPlatformInfo();
  if (os === 'mac') return 'mac';
  if (os === 'win') return 'win';
  if (os === 'linux' || os === 'openbsd') return 'linux';
  return 'other';
}

/** Hand the request to the tab the user is looking at. */
async function translateActivePage(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const message: TranslatePageMessage = { type: 'TRANSLATE_PAGE' };
  // Pages the content script cannot run on (chrome://, the Web Store) have no
  // receiver. Nothing to report — the popup is closing either way.
  await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
}

/**
 * The host of the tab the popup was opened over.
 *
 * Null for anything without one — `chrome://`, the Web Store, a blank tab —
 * and for a URL that will not parse, which is the same answer as far as "never
 * translate this site" is concerned.
 */
async function activeHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    const { protocol, hostname } = new URL(tab.url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return hostname || null;
  } catch {
    return null;
  }
}

mountPopup(document, {
  probe: probeOllama,
  platformOs,
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  translateActivePage,
  activeHost,
});
