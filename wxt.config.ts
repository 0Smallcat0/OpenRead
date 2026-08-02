import { defineConfig } from 'wxt';

// WXT generates the MV3 manifest from these fields + the files in src/entrypoints.
// See https://wxt.dev for the entrypoint conventions.
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'OpenRead',
    // Least-privilege: v1 declared `scripting` + `declarativeNetRequest` but never
    // used them (store-review red flag). Dropped. We only need storage + the
    // broad host access required to inject the selection UI on any page/PDF.
    permissions: ['storage', 'activeTab'],
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
      // and undoing it. Ctrl+Shift+G is unbound in a default Chrome.
      'translate-page': {
        suggested_key: {
          default: 'Ctrl+Shift+G',
          mac: 'Command+Shift+G',
        },
        description: 'Translate the whole page (again to undo)',
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
