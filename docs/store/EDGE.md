# Microsoft Edge Add-ons

The same MV3 package, in a second store. Nothing in the extension changes: Edge
is Chromium, the manifest is the one Chrome takes, and the zip is the one the
release workflow already builds.

> **What is done and what is not.** The extension has been driven end to end in
> a real Edge — see [Measured on Edge](#measured-on-edge) below. Everything
> from "register a developer account" onwards is account work, and only the
> account holder can do it.

## Measured on Edge

Edge 151.0.4129.78, OpenRead 2.21.0, a profile that had never translated
anything. Driven with the repository's own harnesses, pointed at Edge instead
of Chrome:

```bash
EDGE="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
OPENREAD_CHROME="$EDGE" pnpm e2e:first-run
OPENREAD_CHROME="$EDGE" pnpm e2e:epub
OPENREAD_CHROME="$EDGE" pnpm e2e:egress
```

|                          |                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `Translator` API         | **present** — the default engine works, so "nothing to install" is true on Edge too |
| `LanguageDetector` API   | present                                                                             |
| First translation, cold  | language pack in **14 s**, then 18 blocks in 4 s                                    |
| EPUB reader              | opens, reads, translates, follows the reader into the next chapter                  |
| `pnpm e2e:egress`        | **PASS** — 4 requests observed, 0 off the machine                                                                               |
| Keyboard shortcuts       | **all three unbound** — see below                                                   |

### The keyboard shortcuts do not bind on Edge

`chrome.commands.getAll()` reports an empty `shortcut` for
`translate-selection`, `translate-page` and `translate-input`. The same call on
Chrome 151 reports `Ctrl+Shift+Y`, `Ctrl+Shift+U` and `Ctrl+Shift+K`.

This is the behaviour this project already met on Chrome, in another browser:
a suggested combination the browser has claimed for itself is answered by
registering the command and leaving it unbound — silently, with the manifest
still reading correctly. Edge claims `Ctrl+Shift+U` for Read Aloud and
`Ctrl+Shift+Y` for Collections.

**The suggestions are not being changed to suit Edge.** Chrome is where the
users are, those keys work there, and moving them would take a working
shortcut away from everyone to fix one that is unreachable anyway — Edge would
simply claim the next choice too. What the product does instead is what it
already did about this class of failure: every feature has a route that is not
a keyboard shortcut. Whole-page translation is in the right-click menu and in
the popup; selection translation is the floating 文; one paragraph is the hover
key. A reader who wants the shortcuts can assign them by hand at
`edge://extensions/shortcuts`, which the README now says.

**Do not write the shortcuts into the Edge listing copy.** The Chrome listing
may keep them.

## What only the account holder can do

1. **Register at [Microsoft Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/public/login).**
   Registration for Edge extensions is **free** — there is no equivalent of the
   Chrome Web Store's one-time $5. It needs a Microsoft account and identity
   verification, which is where the time goes.
2. **Create the submission**, fill the listing from the copy below, upload the
   package, and press Publish.

## The package

Take `openread-<version>-chrome.zip` from the
[GitHub release](https://github.com/0Smallcat0/OpenRead/releases/latest). Not a
local `pnpm zip`: the release workflow exists so that what ships is built from
a tag rather than from someone's laptop, and the Chrome Web Store gets the same
file.

Edge accepts the Chrome MV3 manifest as it is. No repackaging, no manifest
edits, no separate build.

## Listing

Name, descriptions, category and privacy answers are the same product, so they
come from [`LISTING.md`](LISTING.md) — with two differences:

- **Short description**: Edge allows more room than the Chrome Web Store's 132
  characters, but the copy in `LISTING.md` is already written to be complete at
  that length. Reuse it rather than inventing a second version to keep in sync.
- **No keyboard shortcuts**, for the reason above.

### Store logo — the one thing that has to be made

Edge requires a **300×300 PNG** store logo. The repository ships
`public/icon/{16,32,48,128}.png`, no vector source, and nothing larger, so
there is nothing here to resize from without it going soft. This is the only
asset the Chrome listing never needed and the only thing standing between the
package and a submission.

### Screenshots

Nothing to do. Edge requires **1280×800 or 640×480**, at least one and at most
ten, and `docs/store/screenshots/` already holds four at exactly 1280×800 — the
same set the Chrome listing uses:

| File                             | Shows                                   |
| -------------------------------- | --------------------------------------- |
| `screenshot-1-translate-web.png` | a whole page, bilingual                 |
| `screenshot-2-select-icon.png`   | selecting a passage and the floating 文 |
| `screenshot-3-pdf.png`           | the bundled PDF viewer                  |
| `screenshot-4-popup.png`         | the settings popup                      |

(The images under `docs/screenshots/` are the README's, not the store's, and
are the wrong sizes for either listing. They are not the ones to upload.)

Neither set shows the EPUB reader, which shipped in 2.21.0. Worth a fifth shot
eventually, in both stores; not worth blocking a first submission on.

### Privacy

Edge asks the same questions the Chrome listing answered, and the answers do
not change: no data is collected, and nothing leaves the machine. Point the
privacy policy field at
<https://github.com/0Smallcat0/OpenRead/blob/main/PRIVACY.md>.

The claim is testable rather than asserted, and saying so is worth a line in
the submission notes: `pnpm e2e:egress` loads the built extension into a real
browser, translates a page served from `127.0.0.1`, and fails if any request
left the machine. It was run against Edge for this listing.

## After it is live

- Put the Edge listing URL in the README beside the Chrome Web Store badge.
- Record the item id here, as `SUBMISSION.md` does for Chrome.
- Edge review is typically slower than Chrome's on a first submission. As with
  Chrome, the live version keeps serving while an update is in review, and no
  new package may be uploaded while one is pending.
