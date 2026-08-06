# Privacy Policy — OpenRead

_Last updated: 2026-08-06_

OpenRead is a local-first browser extension. It is designed so that your data
never leaves your machine.

## What the extension collects

**Nothing.** OpenRead has no analytics, no telemetry, no crash reporting, no
accounts, and no remote servers operated by the developer. The developer
receives no data of any kind from your use of the extension.

## What happens to the text you select

It depends on which engine you have chosen in the popup.

- **Chrome's built-in translator (the default).** The text is handed to
  Chrome's own on-device translation model. It does not leave the browser, and
  the extension makes no network request at all. Chrome downloads a language
  pack from Google the first time you use a language pair; that download
  carries the language pair, not your text.
- **Ollama.** The text is sent to the server at the URL you configure — by
  default `http://localhost:11434`, i.e. your own computer — and inference runs
  on that machine. If you point the URL at a remote machine, the text goes to
  that machine, which you chose and control.

In neither case is the text sent to the developer or to any third party.

**Automatic translation** is off until you turn it on, and it changes what gets
translated, not where it goes. Once on, a page you open is handed to whichever
engine you chose without you pressing anything — so on the default engine
nothing leaves your machine either way, but if you have pointed the Ollama URL
at a remote server, that server now sees pages you merely visited rather than
pages you asked about. The popup can exclude a site permanently, and the whole
feature can be turned off in one control.

## Checking this yourself

Everything above is a claim by the person who wrote the extension, which is the
weakest kind of evidence there is. It can be checked without reading the source
and without taking anyone's word for it:

```bash
pnpm build
pnpm e2e:egress
```

That loads the built extension into a real Chrome, serves a page from
`127.0.0.1`, translates the whole thing on the default engine, and records
every network request every part of the extension makes while it happens. It
fails if any of them left the machine, if any of them went to Ollama — which
would mean the built-in engine was not what served the run — or if nothing was
actually translated, since a run that translates nothing sends nothing and
would prove nothing.

`e2e/no-egress.mjs` is the whole thing, and it is short enough to read before
you run it.

## What is stored, and where

- **Settings** (engine, Ollama server URL, model name, target language,
  automatic-translation mode and the list of sites excluded from it,
  Obsidian vault and folder, enrichment toggle) are stored with
  `chrome.storage.sync`. They stay inside your browser profile; Chrome may sync
  them across your own signed-in browsers as with any extension setting.
- **Captured notes** ("Save to Obsidian") are written to your local Obsidian
  vault via the `obsidian://` URL scheme, or copied to your clipboard as a
  fallback. They are not transmitted anywhere else.

## Permissions

- `storage` — persist the settings above.
- `activeTab` and host access on all sites — inject the selection-translate UI
  on pages you read, translate a page when you ask for it, and route `.pdf`
  navigations into the bundled PDF.js viewer. Page content is read only when
  you select text and invoke a translation, or explicitly ask for the whole
  page.
- `contextMenus` — add the two right-click entries ("Translate selection with
  OpenRead", "Translate this page with OpenRead"). It reads nothing.
- `declarativeNetRequest` — strip the `Origin` header from **this extension's
  own** requests to the Ollama server you configured, which is what removes the
  `OLLAMA_ORIGINS` setup step. The rule is scoped to requests with no owning
  tab and to that server's URL, so a web page's requests never match it and it
  cannot be used to reach a local model on a page's behalf. It observes no
  traffic: `declarativeNetRequest` acts on rules declared in advance and gives
  the extension no visibility into your browsing.

## Remote code

None. All code ships inside the extension package. On the default engine the
extension makes no network requests; on the Ollama engine it makes them only to
the server URL you configure.

## Changes

Changes to this policy are made via commits to this repository and take effect
when a new extension version is published.

## Contact

Open an issue at <https://github.com/0Smallcat0/OpenRead/issues>.
