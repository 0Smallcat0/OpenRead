import { defineConfig } from 'wxt';

// WXT generates the MV3 manifest from these fields + the files in src/entrypoints.
// See https://wxt.dev for the entrypoint conventions.
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'OpenRead',
    // Explicit, because WXT otherwise inherits `description` from package.json,
    // and that one is written for npm (188 chars). The Chrome Web Store rejects
    // an upload whose manifest description exceeds 132 characters, and it
    // prefills the listing's short description from this field — so it is kept
    // identical to the EN short description in docs/store/LISTING.md.
    description:
      'Bilingual whole-page translation for web pages, PDFs and EPUBs, entirely on your own machine. No account, no API key, no setup.',
    // Least-privilege: v1 declared `scripting` + `declarativeNetRequest` but
    // used neither, which is a store-review red flag. `scripting` stays gone.
    // `declarativeNetRequest` is back in 2.5.0 with an actual job: one
    // session rule strips the `Origin` header from this extension's own
    // requests to the configured Ollama server, which is what removes the
    // OLLAMA_ORIGINS setup step entirely. Scoped in `core/dnr-rule.ts` so it
    // cannot apply to a web page's requests.
    // `contextMenus` earns its place: right-click is where a user looks for
    // "translate this page", and until 2.7.3 the feature lived only behind a
    // toolbar popup and a keyboard shortcut — findable by someone who read the
    // README, invisible to everyone else.
    permissions: [
      'storage',
      'activeTab',
      'declarativeNetRequest',
      'contextMenus',
    ],
    // A keyboard user can select text but never produces a mouseup, so the
    // floating 文 icon is not a route they can take. This is: remappable at
    // chrome://extensions/shortcuts, and it needs no extra permission.
    commands: {
      'translate-selection': {
        suggested_key: {
          default: 'Ctrl+Shift+Y',
          mac: 'Command+Shift+Y',
        },
        description: 'Translate the current selection',
      },
      // Whole-page translation is a toggle, so one binding covers translating
      // and undoing it.
      //
      // Not Ctrl+Shift+G, which this shipped as for five releases: that is
      // Chrome's own "find previous", and Chrome answers a reserved suggestion
      // by leaving the command unassigned rather than by refusing to install.
      // `chrome.commands.getAll()` reported `shortcut: ""` for it while
      // `translate-selection` reported `Ctrl+Shift+Y`, so the documented
      // keyboard route to whole-page translation did nothing at all. Probed
      // against a real Chrome: G dropped, U/L/K each assigned.
      // Not L either. L was chosen when G turned out to be Chrome's "find
      // previous", and `chrome.commands.getAll()` now reports L unbound too —
      // so whole-page translation has had no working shortcut for several
      // releases while the manifest looked correct. A manifest test cannot see
      // this; only asking Chrome can, which `e2e:page` now does.
      'translate-page': {
        suggested_key: {
          default: 'Ctrl+Shift+U',
          mac: 'Command+Shift+U',
        },
        description: 'Translate the whole page (again to undo)',
      },
      // The other direction: what you are writing, in the box you are writing
      // it in. K rather than I, which is devtools, or G, which Chrome keeps for
      // "find previous" and answers by leaving the command unassigned.
      'translate-input': {
        suggested_key: {
          default: 'Ctrl+Shift+K',
          mac: 'Command+Shift+K',
        },
        description: 'Translate what you are typing',
      },
    },
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [
      {
        // Bundled PDF.js viewer + our injected translation layer.
        resources: ['pdfjs/*'],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
  },
});
