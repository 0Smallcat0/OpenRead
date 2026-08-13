# Chrome Web Store submission guide

**The listing is live.** Item id `mopclgoefogojkfmigfjpbmnnoiodnmb`, public since
2026-08-11.

| | |
| --- | --- |
| Public page | <https://chromewebstore.google.com/detail/mopclgoefogojkfmigfjpbmnnoiodnmb> |
| Console item | <https://chrome.google.com/webstore/devconsole/> → the item, or append the item id to the item URL once inside |

Sections 1 and 2 below are the one-time setup and are done. For a new version,
go straight to [section 4](#4-after-approval).

> **Everything in this guide is ready except the parts only you can do.** The
> package builds, the listing copy and the four screenshots are current, and the
> privacy answers are drafted. The one-time **$5 developer registration** is
> paid and the item exists. What remains for each release is the upload itself,
> from your own account — signing in and clicking **Submit** are yours to
> perform, not something to hand to a tool. Budget about five minutes plus
> review time.

Everything below is prepared in this repo; the only steps that need a human are
the final clicks.

## 0. Build the package

```bash
pnpm install
pnpm zip        # -> .output/openread-<version>-chrome.zip
```

## 1. Developer account (one-time)

1. Go to <https://chrome.google.com/webstore/devconsole>.
2. Sign in with the Google account that should own the listing.
3. Pay the one-time **US$5** registration fee.

## 2. Create the item

> For an item that already exists, the upload is not on the listing page: it is
> **Package → Upload new package**. The Store listing tab has no upload control
> at all, which is easy to read as "there is nowhere to put the new build".

1. **Add new item** → upload `.output/openread-<version>-chrome.zip`.
2. **Store listing tab** — paste from [`LISTING.md`](LISTING.md):
   name, short description, detailed description, category
   (Productivity → Tools), language.
3. Upload the four 1280×800 screenshots from
   [`screenshots/`](screenshots/), in the numbered order.
4. **Privacy tab** — paste the single-purpose statement, the three permission
   justifications, remote code = **No**, data collection = **none**, and the
   privacy policy URL, all from the "Privacy tab answers" section of
   `LISTING.md`.
5. **Distribution tab** — visibility:
   - **Public** — anyone can find it; or
   - **Unlisted** — installable only via the direct link. For a resume/portfolio
     link this is enough and avoids discoverability pressure. Recommended
     starting point; it can be flipped to Public later.

## 3. Submit for review

Click **Submit for review**. Expect a longer-than-average review because the
extension requests `<all_urls>` host access — the justifications in the privacy
tab address exactly that. Typical turnaround is a few days.

## 4. Shipping a new version

1. Bump `version` in `package.json` and run `pnpm zip`.
2. Open the item in the console, go to the **Package** tab, and
   **Upload new package** — `.output/openread-<version>-chrome.zip`.
   The Store listing tab has no upload control; see the note in section 2.
3. Re-read the listing copy only if the product changed shape. Re-shoot the
   screenshots if the UI did.
4. **Submit for review.** The live version stays up and serves users unchanged
   until the new one is approved — a review in flight costs nothing.
5. Do not upload a new package while a review is pending. Wait for the verdict.

The store link is already in the README badge row and the Install section.
It still needs to go into the resume bullets.

## Gotchas

- The zip must come from `pnpm zip` (WXT), not from zipping `.output/chrome-mv3`
  by hand — WXT sets the layout the store expects. It does keep the bundled
  PDF.js `.map` files (about 9 MB of the 6.9 MB compressed zip); that is
  deliberate. Reviewers read the package, and unreadable minified code is a
  common cause of a slow or failed review.
- The manifest `description` must be **≤ 132 characters** or the upload is
  rejected outright. It is set explicitly in `wxt.config.ts` for that reason —
  WXT would otherwise inherit `package.json`'s description, which is written
  for npm and is 188 characters. Keep it in sync with the EN short description
  in [`LISTING.md`](LISTING.md); the store prefills that field from it.
- Don't change the manifest permissions between review cycles unless necessary;
  every permission change re-triggers in-depth review.
- The listing screenshots are real end-to-end captures of the built extension
  running in Chrome; if they are re-shot, keep them honest — no mock-ups.
- The first screenshot is what appears in search results, so it leads with
  whole-page bilingual translation rather than the settings popup.
- Re-shoot them whenever the UI changes. The set before 2.11.0 showed an
  Ollama-only product and no whole-page translation, which by then described
  something the extension no longer was.
