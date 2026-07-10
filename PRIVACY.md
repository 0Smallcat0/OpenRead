# Privacy Policy — OpenRead

_Last updated: 2026-07-10_

OpenRead is a local-first browser extension. It is designed so that your data
never leaves your machine.

## What the extension collects

**Nothing.** OpenRead has no analytics, no telemetry, no crash reporting, no
accounts, and no remote servers operated by the developer. The developer
receives no data of any kind from your use of the extension.

## What happens to the text you select

When you trigger a translation (or an optional capture enrichment), the
selected text is sent to **your own Ollama server** at the URL you configure in
the popup — by default `http://localhost:11434`, i.e. your own computer.
Inference runs entirely on that machine. The text is not sent to the developer
or to any third party.

If you point the server URL at a remote machine, the text goes to that machine
— which you chose and control.

## What is stored, and where

- **Settings** (Ollama server URL, model name, target language, Obsidian vault
  and folder, enrichment toggle) are stored with `chrome.storage.sync`. They
  stay inside your browser profile; Chrome may sync them across your own
  signed-in browsers as with any extension setting.
- **Captured notes** ("Save to Obsidian") are written to your local Obsidian
  vault via the `obsidian://` URL scheme, or copied to your clipboard as a
  fallback. They are not transmitted anywhere else.

## Permissions

- `storage` — persist the settings above.
- `activeTab` / host access on all sites — inject the selection-translate UI
  on pages you read and route `.pdf` navigations into the bundled PDF.js
  viewer. Page content is only read when you explicitly select text and click
  the translate icon.

## Remote code

None. All code ships inside the extension package. The extension makes network
requests only to the Ollama server URL you configure.

## Changes

Changes to this policy are made via commits to this repository and take effect
when a new extension version is published.

## Contact

Open an issue at <https://github.com/0Smallcat0/OpenRead/issues>.
