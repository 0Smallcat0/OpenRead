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
