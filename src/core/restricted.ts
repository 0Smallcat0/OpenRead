/**
 * Pages Chrome will not let any extension touch, named before the user presses.
 *
 * A content script is injected by Chrome, not by this extension, and Chrome
 * refuses on a short list of addresses: its own `chrome://` pages, the Web
 * Store, and the pages the browser itself is built out of. On one of those the
 * toolbar button is delivered to nobody, the page does not change, and nothing
 * anywhere says why — which is indistinguishable from an extension that does
 * not work, and is the state a user is in for the first minute after
 * installing, because the tab they are looking at is the Web Store listing they
 * just installed from.
 *
 * Pure and framework-free: a URL string in, a sentence or null out.
 */

/** Schemes that are the browser's own furniture rather than a web page. */
const BROWSER_SCHEMES = new Set([
  'chrome:',
  'chrome-untrusted:',
  'devtools:',
  'about:',
  // Chromium forks keep their own. Named because this extension runs on Edge
  // too, and a user there meets exactly the same wall.
  'edge:',
  'brave:',
  'opera:',
  'vivaldi:',
]);

/**
 * Why this page cannot be translated, or null when there is no such reason.
 *
 * Null is also the answer for a URL that will not parse and for one that was
 * never known — "cannot tell" must not be reported as "cannot work", because
 * the cost of a false alarm here is telling a reader their page is unusable
 * while it sits there perfectly translatable.
 */
export function describeRestrictedPage(url: string | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (BROWSER_SCHEMES.has(parsed.protocol)) {
    return (
      'Chrome does not allow any extension to run on its own pages, so this ' +
      'one cannot be translated. Open an ordinary web page and try there.'
    );
  }

  const host = parsed.hostname.toLowerCase();
  const webStore =
    host === 'chromewebstore.google.com' ||
    (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) ||
    host === 'microsoftedge.microsoft.com';
  if (webStore) {
    return (
      'Chrome does not allow any extension to run on the extension store, ' +
      'so this page cannot be translated. It works everywhere else — try it ' +
      'on an article.'
    );
  }

  return null;
}
