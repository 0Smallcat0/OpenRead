# Chrome Web Store listing copy

Paste-ready copy for the store listing, current as of **2.11.0**. Two languages
are provided; pick one as the listing language (zh-TW recommended for the
primary audience) and add the other via the dashboard's localized-listing
option if desired.

> Rewritten for 2.11.0. The previous copy described an Ollama-only product and
> told the reader to set `OLLAMA_ORIGINS` before starting the server — a step
> 2.5.0 removed, and a requirement 2.7.0 removed, since the default engine is
> Chrome's own on-device translator and needs nothing installed.

## Name (≤ 45 chars)

- **zh-TW:** `OpenRead — 網頁/PDF 雙語翻譯，全在本機`
- **EN:** `OpenRead — Private Web & PDF Translation`

## Short description (≤ 132 chars)

- **zh-TW:** `整頁雙語翻譯網頁與 PDF，譯文附在原文下方。全程在你的電腦上完成，免帳號、免金鑰、零追蹤，裝好就能用。`
- **EN:** `Bilingual whole-page translation for web pages and PDFs, entirely on your own machine. No account, no API key, no setup.`

## Detailed description

### zh-TW

```
按一下「翻譯整頁」，每一段的譯文就出現在原文下方——雙語對照，全部在你自己的
電腦上完成。也可以只選取一句，翻譯直接顯示在原地。

裝好就能用。預設使用 Chrome 內建的裝置端翻譯模型，不需要安裝伺服器、不需要
API 金鑰、不需要帳號。第一次翻某個語言對時，Chrome 會下載該語言包（一兩分鐘，
有進度顯示），之後一整頁大約兩秒。

沒有雲端，沒有遙測。你讀的內容不會離開你的機器，也不會傳給開發者或任何第三方。
適合不能上傳雲端的文件：未發表的論文、合約、內部資料。

特色
• 整頁雙語翻譯：譯文附在原文下方而非取代原文，看起來怪的句子可以立刻對照原文
• 網頁與 PDF 通用：內建 PDF.js 檢視器，.pdf 連結自動導入，選字翻譯用法完全相同
• 台灣用語在地化：OpenCC s2twp 詞組級簡繁轉換（界面→介面、公里不會變公裡），
  另有一層針對內建引擎的台灣詞彙修正（用戶→使用者、運行→執行）
• 同語言短路：內容已是目標語言時直接跳過翻譯，零延遲零成本
• 一鍵存到 Obsidian：翻譯結果連同原文與 YAML frontmatter 寫成筆記
• 想要更強的可以換引擎：接本機 Ollama 用大型語言模型翻譯，它會參考頁面上下文、
  可以自己選模型，並且解鎖擷取筆記的自動摘要與標籤
• 鍵盤可用：Ctrl+Shift+Y 翻譯選取範圍，Esc 關閉面板，面板本身是有標記的對話框

需求
• Chrome 138 以上（內建翻譯模型由 Chrome 提供）
• 選用 Ollama 引擎時才需要：安裝 Ollama（0.9 以上）並拉取一個模型，
  例如 ollama pull qwen3。不需要設定任何環境變數。

開源（MIT）：https://github.com/0Smallcat0/OpenRead
工程細節與評測方法：https://github.com/0Smallcat0/OpenRead/blob/main/docs/ENGINEERING.md
```

### EN

```
Click "Translate this page" and every paragraph's translation appears
underneath the original — bilingual, entirely on your own machine. Or select
a single sentence and read the translation in place.

It works the moment you install it. The default engine is Chrome's own
on-device translation model: no server to install, no API key, no account.
The first time you use a language pair Chrome downloads that language pack
(a minute or two, with a progress indicator); after that a whole page takes
about two seconds.

No cloud, no telemetry. What you read does not leave your machine and is
never sent to the developer or any third party — which makes this usable on
the documents a cloud translator is not: unpublished drafts, contracts,
internal material.

Features
• Whole-page bilingual translation — the translation is appended under the
  original, never over it, so a sentence that looks wrong can be checked
• Web pages and PDFs alike — .pdf navigations open in a bundled PDF.js
  viewer with the same select-to-translate UI
• Taiwan-convention Chinese — OpenCC s2twp phrase-level conversion, plus a
  vocabulary pass that fixes the mainland word choices Chrome's zh-Hant
  output uses (用戶 -> 使用者, 運行 -> 執行)
• Same-language short-circuit: content already in the target language is
  skipped entirely
• One-tap capture to Obsidian: original + translation + YAML frontmatter
• A stronger engine when you want one: point it at a local Ollama server to
  translate with an LLM that reads the surrounding page, choose your own
  model, and unlock automatic titles, summaries and tags on captures
• Keyboard-workable: Ctrl+Shift+Y translates the selection, Escape closes
  the panel, and the panel is a labelled dialog with a live region

Requirements
• Chrome 138 or later (the built-in translation model ships with Chrome)
• Only if you switch to the Ollama engine: Ollama 0.9+ with a model pulled,
  e.g. `ollama pull qwen3`. No environment variables to set.

Open source (MIT): https://github.com/0Smallcat0/OpenRead
Engineering & evaluation: https://github.com/0Smallcat0/OpenRead/blob/main/docs/ENGINEERING.md
```

## Category & language

- Category: **Productivity → Tools**
- Listing language: **中文（繁體）** (or English)

## Graphics

- Icon: taken from the package (`icon/128.png`) automatically.
- Screenshots (1280×800, in [`screenshots/`](screenshots/)), re-shot against
  2.11.0 on the default built-in engine:
  1. `screenshot-1-translate-web.png` — whole-page bilingual translation on a
     Wikipedia article, with the progress badge showing the finished count.
     This is the one that appears in search results, so it leads with the
     headline feature.
  2. `screenshot-2-select-icon.png` — one paragraph selected, the translation
     panel, and its Save-to-Obsidian and Copy actions.
  3. `screenshot-3-pdf.png` — the same selection UI inside the bundled PDF.js
     viewer, on a paper.
  4. `screenshot-4-popup.png` — the settings popup, showing the built-in
     engine selected and no server fields to fill in.

  All four are real end-to-end captures of the built extension running in
  Chrome — no mock-ups. Only the popup shot is staged, and only in placement:
  the popup document is ~350 px wide, so it is centred in the 1280×800 frame
  rather than stranded in a corner. If they are re-shot, keep them honest.

- Promo tile (440×280): optional; not provided.

## Privacy tab answers

- **Single purpose:** Translate web page and PDF content — a user selection or
  the whole page — on the user's own machine, using Chrome's built-in
  on-device translator or a local LLM server the user runs, with optional
  saving of the result as a note.
- **Permission justifications:**
  - `storage` — persist user settings (engine, Ollama server URL, model,
    target language, Obsidian vault/folder, enrichment toggle).
  - `activeTab` — interact with the currently active tab when the user invokes
    the selection UI, asks for a whole-page translation, or opens a local PDF
    in the bundled viewer.
  - `contextMenus` — add the two right-click entries the features are invoked
    from ("Translate selection with OpenRead", "Translate this page with
    OpenRead"). It reads no page content.
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
