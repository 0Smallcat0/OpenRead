# Privacy Policy — OpenRead

_Last updated: 2026-10-21_

OpenRead is a local-first browser extension. On its two default engines your
data never leaves your machine; the optional third sends the text you translate
to an API you name, and to nothing else.

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
- **Your own API (opt-in).** The text, with a few sentences around it for
  context, is sent to the OpenAI-compatible address you enter — OpenAI,
  DeepSeek, OpenRouter, Google, Groq, or a server on your own computer — with
  the key you paste. That provider handles it under its own terms and bills
  your key. Nothing is sent there until you choose this engine.

In no case is the text sent to the developer, and on the first two engines it
is sent to no third party at all.

**YouTube captions** follow the same rules. With the setting on and captions
(CC) turned on in a video, the extension reads the caption track YouTube's own
player has downloaded and hands its lines, a minute or so ahead of playback, to
whichever engine you chose. It makes no request to YouTube of its own, and
turning CC off stops it.

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
  YouTube captions on or off, Obsidian vault and folder, enrichment toggle)
  are stored with
  `chrome.storage.sync`. They stay inside your browser profile; Chrome may sync
  them across your own signed-in browsers as with any extension setting. The
  API address and model name are among them.
- **Your API key**, if you enter one, is stored with `chrome.storage.local`:
  in this browser profile only, never synced, and sent only to the API address
  you entered alongside it.
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
- `contextMenus` — add the three right-click entries ("Translate selection with
  OpenRead", "Translate this page with OpenRead", "Translate what you typed
  with OpenRead"). It reads nothing.
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
the server URL you configure; on your own API, only to the address you enter.

## Chrome Web Store User Data Policy

The use of information received by OpenRead adheres to the Chrome Web Store
User Data Policy, including the Limited Use requirements. The text you
translate is used only to translate it for you; it is not sold, not used for
advertising, not read by any person, and not transferred to anyone except the
API you name for the third engine.

## Changes

Changes to this policy are made via commits to this repository and take effect
when a new extension version is published.

## Contact

Open an issue at <https://github.com/0Smallcat0/OpenRead/issues>.
