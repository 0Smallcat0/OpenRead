# Chrome Web Store listing copy

Paste-ready copy for the store listing, current as of **2.24.0** (your own
API key, YouTube captions).

> **Who it is written for.** The readers most likely to install a free,
> no-login translator today are the ones a paid one has just pushed out: its
> free tier lost its machine translation engines in mid-2026 and began
> requiring a sign-in. Their complaints, counted in its 1–2 star reviews, are
> the paywall and quota, being made to log in, and free quality falling off —
> so the copy leads with exactly those: free, unlimited, no sign-in, and
> YouTube captions, which is the one feature they say they stayed for. It
> names no other product; the store treats that as keyword spam.

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

- **EN** (122): `Bilingual translation for web pages, PDFs, EPUBs and YouTube captions, on your own machine. No account, no API key needed.`
- **zh-TW** (70): `網頁、PDF、EPUB 與 YouTube 字幕的雙語翻譯，譯文接在原文下方。預設全程在你的電腦上完成，免帳號、免金鑰、免登入，裝好就能用。`
- **zh-CN** (68): `网页、PDF、EPUB 与 YouTube 字幕的双语翻译，译文接在原文下方。默认全程在你的电脑上完成，免账号、免密钥、免登录，不限量。`
- **ja** (72): `ウェブページ・PDF・EPUB・YouTube 字幕を対訳表示で翻訳。既定ではすべて自分の PC 上で完結し、アカウントも API キーも不要。`

> The EN line is `manifest.description` as well, which is what the store
> prefills and what every locale without a listing of its own shows. "No API
> key **needed**" rather than "no API key": one can now be entered, and a
> listing that says there is none would be wrong the day someone does.

## Detailed description

> **Short on purpose.** This was 3,800 characters and fifteen bullets — a
> specification, written for someone who had already decided. A store page is
> read by someone deciding, and they read the title, the first screenshot and
> about two lines. Everything the long version listed is still true and still
> in the README; a reader who wants the glossary, the appearance settings or
> the accessibility notes is a reader who will click through. Keep this under
> a thousand characters.

### EN

```
Translate a whole page and every paragraph's translation appears under the
original, so anything that reads oddly can be checked against it. Turn on
captions on YouTube and every line gets its translation too.

Free, unlimited, and nothing to sign in to: by default it runs on Chrome's own
on-device translation model, so what you read never leaves your machine — no
cloud, no account, no telemetry. Which also makes it usable on what a cloud
translator is not: unpublished drafts, contracts, internal material.

• Whole pages, PDFs and EPUBs — a PDF keeps its layout; a book opens in a
  reader that remembers where you were
• YouTube captions, bilingual — auto-generated ones are put back into
  sentences first, instead of being translated a fragment at a time
• One paragraph — hold Alt and point at it; the box you are typing in —
  Ctrl+Shift+K replaces what you wrote
• 39 target languages, with Traditional Chinese in Taiwan wording
• Want a stronger model? A local Ollama server, or your own API key (OpenAI,
  DeepSeek, Gemini, OpenRouter…)

Needs Chrome 138 or later, on desktop.

Open source (MIT): https://github.com/0Smallcat0/OpenRead
```

### zh-TW

```
翻譯整頁，每一段的譯文就接在原文下方，看起來怪的句子可以立刻對照。在 YouTube
打開字幕，每一句也會附上譯文。

免費、不限次數、不用登入：預設用 Chrome 內建的裝置端翻譯模型，你讀的內容不會
離開你的電腦——沒有雲端、沒有帳號、沒有遙測。所以也能用在不能上傳雲端的文件
上：未發表的論文、合約、內部資料。

• 網頁、PDF、EPUB 都可以——PDF 版面不動；電子書在閱讀器裡打開，記得你讀到哪
• YouTube 雙語字幕——自動產生的字幕會先依說話的停頓補回句子再翻，不是一段一段
  碎著翻
• 只翻一段——按住 Alt 指過去；你正在打的字——Ctrl+Shift+K 換成譯文
• 39 種目標語言，繁體中文用台灣的說法
• 想要更強的：接本機 Ollama，或填你自己的 API 金鑰（OpenAI、DeepSeek、
  Gemini、OpenRouter…）

需要 Chrome 138 以上的桌面版。

開源（MIT）：https://github.com/0Smallcat0/OpenRead
```

### zh-CN

```
翻译整页，每一段的译文就接在原文下方，读着别扭的句子可以马上对照。在 YouTube
打开字幕，每一句也会附上译文。

免费、不限次数、不用登录：默认使用 Chrome 内置的端侧翻译模型，你读的内容不会
离开你的电脑——没有云端、没有账号、没有遥测。所以也能用在不能上传云端的文档
上：未发表的论文、合同、内部资料。

• 网页、PDF、EPUB 都能翻——PDF 版式不动；电子书在阅读器里打开，记住你读到哪
• YouTube 双语字幕——自动生成的字幕会先按说话的停顿还原成句子再翻，不是一截
  一截地碎翻
• 只翻一段——按住 Alt 指过去；正在输入的文字——Ctrl+Shift+K 换成译文
• 39 种目标语言
• 想要更强的：接本机 Ollama，或填你自己的 API 密钥（OpenAI、DeepSeek、
  Gemini、OpenRouter…）

需要 Chrome 138 及以上的桌面版。

开源（MIT）：https://github.com/0Smallcat0/OpenRead
```

### ja

```
ページ全体を翻訳すると、各段落の訳文が原文のすぐ下に入るので、気になる一文は
その場で原文と見比べられます。YouTube で字幕をオンにすれば、字幕も一行ずつ
対訳になります。

無料・回数制限なし・ログイン不要。既定では Chrome 内蔵のオンデバイス翻訳モデル
で動くため、読んでいる内容が PC の外に出ることはありません。クラウドもアカウント
もテレメトリもなし。クラウド翻訳に入れられない文書——未発表の論文、契約書、社内
資料——にも使えます。

• ウェブページ・PDF・EPUB に対応——PDF はレイアウトそのまま、電子書籍は
  読んだ位置を覚えるリーダーで開きます
• YouTube の対訳字幕——自動生成字幕は話の切れ目で文に組み直してから翻訳する
  ので、細切れの訳になりません
• 一段落だけ——Alt を押しながら指すだけ。入力中の文章は Ctrl+Shift+K で訳文に
• 翻訳先は 39 言語
• もっと高性能なモデルを使いたいときは、ローカルの Ollama か、自分の API キー
  （OpenAI、DeepSeek、Gemini、OpenRouter など）

Chrome 138 以降のデスクトップ版が必要です。

オープンソース（MIT）：https://github.com/0Smallcat0/OpenRead
```

## Category & language

- Category: **Productivity → Tools**
- **All-languages listing: English.** It is what every locale without its own
  listing falls back to.
- **zh-TW, zh-CN and ja: a localized listing each**, added from the language
  selector, using the copy above. Optional — English already reaches
  everyone — but a localized listing is the only way to rank for 翻譯／翻译／
  翻訳 in those store surfaces, and those three are where the readers leaving
  a paid translator's free tier are writing their reviews.

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
  selection, a paragraph, a whole page, a whole PDF, the captions of the
  YouTube video they are watching, or the text field they are typing in — using
  Chrome's built-in on-device translator, a local LLM server the user runs, or
  an OpenAI-compatible API the user names with their own key, with optional
  saving of the result as a note.
- **Permission justifications:**
  - `storage` — persist user settings (engine, Ollama server URL, model,
    the user's API address and model, target language, the language typed text
    is translated into, automatic translation and its per-site exceptions,
    YouTube captions on or off, appearance, the user's glossary of terms,
    Obsidian vault/folder, enrichment toggle). The user's API key is kept in
    `chrome.storage.local` — this browser profile only, never synced.
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
    whole page. On youtube.com the extension reads the caption track YouTube's
    own player downloads, and translates its lines only while the user has
    captions (CC) on; it makes no request to YouTube of its own.
- **Remote code:** No. All code is packaged. On the default engine the
  extension makes no network requests at all; on the Ollama engine, only to the
  user-configured server; on the user's own API, only to the address the user
  entered.
- **Data usage:** Check **"Website content"** and nothing else, then certify
  all three statements. The extension reads the text the user asks it to
  translate — and, with CC on, a video's captions — and hands it to the engine
  the user chose. That is handling even though on the default engine nothing
  leaves the machine: the store's User Data FAQ (question 3) says extensions
  must disclose how they handle user data "even when data is processed or
  stored locally". The developer receives nothing; text reaches a third party
  only on the user's own API, sent to the address and key the user entered,
  for the translation the user asked for. The privacy policy carries the
  Limited Use statement this disclosure requires. Answering "No, I do not
  collect user data" would disagree with what the extension does, and the
  FAQ lists such a mismatch as grounds for suspension.
- **Privacy policy URL:** `https://github.com/0Smallcat0/OpenRead/blob/main/PRIVACY.md`
