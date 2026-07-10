# Chrome Web Store submission guide

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
  by hand — WXT excludes source maps and sets the layout the store expects.
- Don't change the manifest permissions between review cycles unless necessary;
  every permission change re-triggers in-depth review.
- The listing screenshots are real end-to-end captures (live Ollama + qwen3);
  if they are re-shot, keep them honest — no mock-ups.
