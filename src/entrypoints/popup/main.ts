import { mountPopup } from '../../ui/popup';
import { probeOllama } from '../../api/probe';
import type { PlatformOs } from '../../core/diagnostics';

/** Map Chrome's platform list onto the three shells that need different fixes. */
async function platformOs(): Promise<PlatformOs> {
  const { os } = await chrome.runtime.getPlatformInfo();
  if (os === 'mac') return 'mac';
  if (os === 'win') return 'win';
  if (os === 'linux' || os === 'openbsd') return 'linux';
  return 'other';
}

mountPopup(document, {
  probe: probeOllama,
  platformOs,
  writeClipboard: (text) => navigator.clipboard.writeText(text),
});
