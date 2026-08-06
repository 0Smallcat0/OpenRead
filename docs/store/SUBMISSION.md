# Chrome Web Store submission guide

> **Everything in this guide is ready except the parts only you can do.** The
> package builds, the listing copy and the four screenshots are current as of
> 2.11.0, and the privacy answers are drafted. What remains is a one-time **$5
> developer registration**, paid with your own card, and the upload from your
> own account — account creation and payment are yours to perform, not
> something to hand to a tool. Budget about 20 minutes plus review time.

Everything below is prepared in this repo; the only steps that need a human are
the developer account and the final clicks.

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

## 4. After approval

- Put the store link in the README badge row and in the resume bullets.
- Subsequent releases: bump `version` in `package.json`, `pnpm zip`, upload the
  new zip on the item's **Package** tab, resubmit.

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
