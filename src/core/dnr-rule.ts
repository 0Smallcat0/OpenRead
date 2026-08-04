/**
 * Removing the setup step instead of explaining it.
 *
 * Ollama answers a request whose `Origin` is unknown to it with a 403, and a
 * browser extension's origin (`chrome-extension://<id>`) is never on its
 * default list. Measured against a stock server: no `Origin` header → 200,
 * `Origin: chrome-extension://…` → 403. The header *is* the wall.
 *
 * So OpenRead strips it, and `OLLAMA_ORIGINS` stops being something a user has
 * to know about. This was the single largest install cost in the project —
 * an environment variable, set differently on three platforms, followed by a
 * server restart, before anything worked at all. Version 2.3.0 responded to it
 * by detecting the failure and printing a good error message, which is not the
 * same as fixing it.
 *
 * The scoping matters more than the trick. `Origin` is what stops a web page
 * from driving a local server it has no business touching, so a rule that
 * stripped it broadly would hand every page on the internet an unauthenticated
 * local model. Two conditions keep that from happening:
 *
 *   1. `tabIds: [-1]` — only requests with no owning tab, which means requests
 *      from this extension's own service worker and pages. A request from a
 *      web page always carries a real tab id and never matches.
 *   2. `urlFilter` anchored to the exact configured Ollama origin — not
 *      localhost generally, and nothing else on the machine.
 *
 * Pure and exported so both conditions are pinned by tests rather than
 * inspected by hand.
 */

/** Session-rule id. Fixed, so updating the rule replaces rather than stacks. */
export const ORIGIN_STRIP_RULE_ID = 1;

/**
 * Build the rule that lets this extension talk to `baseUrl` unconfigured.
 *
 * Returns null when the URL cannot be parsed, in which case no rule is
 * installed — failing to strip a header degrades to the 403 the popup already
 * explains, whereas installing a malformed rule could widen its scope.
 */
export function buildOriginStripRule(
  baseUrl: string,
): chrome.declarativeNetRequest.Rule | null {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  // `new URL` yields "null" for non-http schemes such as data: and about:.
  if (origin === 'null') return null;

  return {
    id: ORIGIN_STRIP_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'origin',
          operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation,
        },
      ],
    },
    condition: {
      // `|` anchors at the start of the URL, so this matches the configured
      // origin and cannot match a host that merely contains it.
      urlFilter: `|${origin}/`,
      // The security boundary: a request from a web page carries that page's
      // tab id, so it can never match, and the page keeps facing Ollama's
      // origin check exactly as before.
      tabIds: [-1],
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };
}
