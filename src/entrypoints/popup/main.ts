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

mountPopup(document, {
  probe: probeOllama,
  platformOs,
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  translateActivePage,
});
