# Chrome Web Store listing copy

Paste-ready copy for the store listing, current as of **2.21.0**.

> **What is actually live, checked in the dashboard on 2026-08-16 — it is a
> mix, and the mix is the worst of both.** The summary is the English one
> (it comes from `manifest.description`, so it follows the package), the
> **detailed description is the zh-TW one**, and the listing's language is set
> to **所有語言 / All languages**. So every English-speaking visitor reads an
> English one-liner and then a wall of Chinese.
>
> **Fix: put the EN description in the All-languages listing.** That one is the
> fallback every locale without its own listing sees, so it has to be the
> widest-reach language. The zh-TW copy then belongs in a **zh-TW localized
> listing** added from the same language selector — the dropdown that currently
> reads 所有語言.

> The copy used to grow a bullet per feature, on the reasoning that a listing
> describing a smaller product than the one it links to loses the install. That
> is true and it is not a licence to write a specification: at 3,800 characters
> and fifteen bullets nobody reached the end, so the features past the fold
> were no more sold than if they had been left out. Completeness lives in the
> README. This sells.

## Name

`OpenRead — Local Bilingual Translation` (38 of the 45 characters a manifest
name may have), shipped in **2.21.1**.

> Not a dashboard field. The store's 套件標題 is `manifest.name`, which is why
> the listing showed a bare `OpenRead` for as long as it did — there was nothing
> to paste anywhere. Changing it means changing `wxt.config.ts` and uploading a
> package, which 2.21.1 is.
>
> Two reasons at once: a bare name carries no keywords, and it sat one space
> away from an unrelated extension called **Open Read** — a paywall shortcut,
> 104 users, v0.1.0, untouched since 2026-02. `short_name` keeps `OpenRead` for
> the toolbar tooltip and the extensions list, where a tagline is only something
> to truncate.

## Short description (≤ 132 chars)

- **zh-TW:** `整頁雙語翻譯網頁、PDF 與 EPUB，譯文附在原文下方。全程在你的電腦上完成，免帳號、免金鑰、零追蹤，裝好就能用。`
- **EN:** `Bilingual whole-page translation for web pages, PDFs and EPUBs, entirely on your own machine. No account, no API key, no setup.`

## Detailed description

> **Short on purpose.** This was 3,800 characters and fifteen bullets — a
> specification, written for someone who had already decided. A store page is
> read by someone deciding, and they read the title, the first screenshot and
> about two lines. Everything the long version listed is still true and still
> in the README; a reader who wants the glossary, the appearance settings or
> the accessibility notes is a reader who will click through. Keep this under
> a thousand characters.

### zh-TW

```
翻譯整頁，每一段的譯文就接在原文下方，看起來怪的句子可以立刻對照。也可以只
選一句，翻譯直接顯示在原地。

不用安裝任何東西，也不用註冊：它用的是 Chrome 內建的裝置端翻譯模型。你讀的
內容不會離開你的電腦——沒有雲端、沒有帳號、沒有 API 金鑰、沒有遙測。所以它
可以用在不能上傳雲端的文件上：未發表的論文、合約、內部資料。

• 網頁、PDF、EPUB 都可以——PDF 版面不動；電子書在閱讀器裡打開，記得你讀到哪
• 只翻一段——按住 Alt 指過去
• 你正在打的字——Ctrl+Shift+K 把它換成譯文
• 39 種目標語言，繁體中文用台灣的說法
• 想要更強的可以接本機 Ollama

需要 Chrome 138 以上的桌面版。

開源（MIT）：https://github.com/0Smallcat0/OpenRead
```

### EN

```
Translate a whole page and every paragraph's translation appears under the
original, so anything that reads oddly can be checked against it. Or select
one sentence and read it in place.

Nothing to install, nothing to sign up for: it runs on Chrome's own on-device
translation model. What you read never leaves your machine — no cloud, no
account, no API key, no telemetry. Which makes it usable on the documents a
cloud translator is not: unpublished drafts, contracts, internal material.

• Whole pages, PDFs and EPUBs — a PDF keeps its layout; a book opens in a
  reader that remembers where you were
• One paragraph — hold Alt and point at it
• The box you are typing in — Ctrl+Shift+K replaces what you wrote
• 39 target languages, with Traditional Chinese in Taiwan wording
• Optional: point it at a local Ollama server for a stronger model

Needs Chrome 138 or later, on desktop.

Open source (MIT): https://github.com/0Smallcat0/OpenRead
```

## Category & language

- Category: **Productivity → Tools**
- **All-languages listing: English.** It is what every locale without its own
  listing falls back to.
- **zh-TW: a localized listing of its own**, added from the language selector,
  using the zh-TW copy above. Optional — English already reaches everyone — but
  it is the only way to rank for 翻譯／繁體中文 in the Chinese store surface.

## Graphics

- Store icon: **upload `public/icon/128.png` by hand**. The dashboard's
  "Store icon" is a required field of its own — the icon inside the package is
  what Chrome shows in the toolbar, not what the store listing shows.
- Screenshots (1280×800, in [`screenshots/`](screenshots/)), re-shot against
  2.18.1 on the default built-in engine:
  1. `screenshot-1-translate-web.png` — whole-page bilingual translation on a
     Wikipedia article, with the progress badge showing the finished count.
     This is the one that appears in search results, so it leads with the
     headline feature.
  2. `screenshot-2-select-icon.png` — one paragraph selected, the translation
     panel, and its Save-to-Obsidian and Copy actions.
  3. `screenshot-3-pdf.png` — a whole PDF translated in the bundled viewer,
     framed on the seam so both halves are visible: the page as the author set
     it, and that page's translation underneath. It used to show the selection
     UI inside the viewer, which is the same gesture as screenshot two — two of
     four frames on one gesture describes a smaller product than this one is.
     Shot at 50% zoom, because the fixture page carries its text at the top and
     at the viewer's default scale the seam sits below a hand's width of blank
     paper.
  4. `screenshot-4-popup.png` — the settings popup: the built-in engine with no
     server fields to fill in, the language-pack line, automatic translation,
     and the appearance settings.

  The store rejects a screenshot that carries an alpha channel — it wants JPEG
  or 24-bit PNG. All four are 24-bit RGB, which is what `pnpm shoot` produces;
  keep it that way if the capture path ever changes.

  All four are real end-to-end captures of the built extension running in
  Chrome — no mock-ups. Only the popup shot is staged, and only in placement:
  the popup document is ~350 px wide, so it is centred in the 1280×800 frame
  rather than stranded in a corner. If they are re-shot, keep them honest.

- Promo tile (440×280): optional; not provided.

## Privacy tab answers

- **Single purpose:** Translate what the user is reading or writing — a
  selection, a paragraph, a whole page, a whole PDF, or the text field they are
  typing in — on the user's own machine, using Chrome's built-in on-device
  translator or a local LLM server the user runs, with optional saving of the
  result as a note.
- **Permission justifications:**
  - `storage` — persist user settings (engine, Ollama server URL, model,
    target language, the language typed text is translated into, automatic
    translation and its per-site exceptions, appearance, the user's glossary of
    terms, Obsidian vault/folder, enrichment toggle).
  - `activeTab` — interact with the currently active tab when the user invokes
    the selection UI, asks for a whole-page translation, or opens a local PDF
    in the bundled viewer.
  - `contextMenus` — add the three right-click entries the features are
    invoked from ("Translate selection with OpenRead", "Translate this page
    with OpenRead", "Translate what you typed with OpenRead"). It reads no page
    content.
  - `declarativeNetRequest` — strip the `Origin` header from this extension's
    own requests to the user-configured Ollama server. Ollama rejects requests
    whose origin it does not recognise, and an extension's origin is never on
    its list, so without this every install began with an environment variable
    and a server restart. One session rule, scoped to requests with no owning
    tab (`tabIds: [-1]`) and to that server's URL, so requests originating from
    web pages never match it. Declarative only: no traffic is observed.
  - Host permission `<all_urls>` — the selection- and page-translate UI must
    work on any site the user reads, and `.pdf` navigations on any host are
    routed into the bundled PDF.js viewer. Page content is read only when the
    user selects text and invokes a translation, or explicitly asks for the
    whole page.
- **Remote code:** No. All code is packaged. On the default engine the
  extension makes no network requests at all; on the Ollama engine, only to the
  user-configured server.
- **Data usage:** Does **not** collect or transmit any user data to the
  developer or third parties. Check "No, I do not collect user data"; certify
  compliance.
- **Privacy policy URL:** `https://github.com/0Smallcat0/OpenRead/blob/main/PRIVACY.md`
