# Chrome Web Store listing copy

Paste-ready copy for the store listing. Two languages are provided; pick one as
the listing language (zh-TW recommended for the primary audience) and add the
other via the dashboard's localized-listing option if desired.

## Name (≤ 45 chars)

- **zh-TW:** `OpenRead — 本地 LLM 網頁/PDF 翻譯（Ollama）`
- **EN:** `OpenRead — Local LLM Web & PDF Translator`

## Short description (≤ 132 chars)

- **zh-TW:** `用你自己的本地 LLM（Ollama）翻譯整頁網頁與 PDF——雙語對照、完全本機、免帳號免金鑰、零追蹤。`
- **EN:** `Translate whole pages and PDFs with your own local LLM via Ollama — bilingual, private, no account, no cloud, no tracking.`

## Detailed description

### zh-TW

```
按一下「翻譯整頁」，每一段的譯文就出現在原文下方——雙語對照，全部在你自己的
電腦上完成。也可以只選取一句，翻譯直接串流顯示在原地。

OpenRead 透過本地 Ollama 伺服器推論，不需要 API 金鑰、不需要帳號、沒有雲端、
沒有任何遙測。你讀的內容只會送到你自己設定的 Ollama 位址（預設
http://localhost:11434），不會離開你的機器。適合不能上傳雲端的文件：未發表的
論文、合約、內部資料。

特色
• 整頁雙語翻譯：譯文附在原文下方而非取代原文，看起來怪的句子可以立刻對照原文
• 網頁與 PDF 通用：內建 PDF.js 檢視器，.pdf 連結自動導入
• 串流輸出 + 可靠性層：以離線評測驅動的清理管線，實測將模型前言、原文回聲、
  簡體字洩漏從 34.8%/17.4%/42.9% 全部降到 0%（數據與方法見 GitHub）
• 台灣用語在地化：OpenCC s2twp 詞組級簡繁轉換（界面→介面、公里不會變公裡）
• 同語言短路：內容已是目標語言時直接跳過模型，零延遲零成本
• 設定面板會實測連線：Ollama 沒開或沒授權時，直接給出可複製的修正指令
• 一鍵存到 Obsidian：翻譯結果連同原文與 YAML frontmatter 寫成筆記
• 預設模型 qwen3 —— 由 4 模型 × 27 題的實測基準選出（chrF、TTFT 皆公開）

需求
• 安裝 Ollama（0.9 以上）並拉取一個模型，例如：ollama pull qwen3
• 啟動前設定環境變數 OLLAMA_ORIGINS=chrome-extension://*

開源（MIT）：https://github.com/0Smallcat0/OpenRead
完整基準與評測方法：https://github.com/0Smallcat0/OpenRead/blob/main/docs/BENCHMARK.md
```

### EN

```
Click "Translate this page" and every paragraph's translation appears
underneath the original — bilingual, entirely on your own machine. Or select
a single sentence and watch the translation stream in place.

OpenRead runs inference through a local Ollama server. No API key, no
account, no cloud, no telemetry. What you read is sent only to the Ollama
URL you configure (default http://localhost:11434) and never leaves your
device — which makes it usable on the documents a cloud translator is not:
unpublished drafts, contracts, internal material.

Features
• Whole-page bilingual translation — the translation is appended under the
  original, never over it, so a sentence that looks wrong can be checked
• Works on web pages and PDFs — .pdf navigations open in a bundled PDF.js
  viewer with the same select-to-translate UI
• Streaming output with an eval-backed reliability layer: measured to cut
  model preamble / input echo / Simplified-character leakage from
  34.8% / 17.4% / 42.9% to 0% on a curated fixture set (data on GitHub)
• Taiwan-convention localization via OpenCC s2twp phrase-level conversion
• Same-language short-circuit: content already in the target language skips
  the model entirely
• The settings panel tests the connection — when Ollama is not running or
  has not allowed the extension, it says so and hands you the fix to copy
• One-tap capture to Obsidian: original + translation + YAML frontmatter
• Default model qwen3 — chosen by a live 4-model × 27-fixture benchmark
  (chrF and TTFT published)

Requirements
• Install Ollama (≥ 0.9) and pull a model, e.g. `ollama pull qwen3`
• Set OLLAMA_ORIGINS=chrome-extension://* before starting Ollama

Open source (MIT): https://github.com/0Smallcat0/OpenRead
Benchmark & methodology: https://github.com/0Smallcat0/OpenRead/blob/main/docs/BENCHMARK.md
```

## Category & language

- Category: **Productivity → Tools**
- Listing language: **中文（繁體）** (or English)

## Graphics

- Icon: taken from the package (`icon/128.png`) automatically.
- Screenshots (1280×800, in [`screenshots/`](screenshots/)):
  1. `screenshot-1-translate-web.png` — streamed translation + capture button on Wikipedia
  2. `screenshot-2-select-icon.png` — selection + floating icon
  3. `screenshot-3-pdf.png` — same UI inside the bundled PDF.js viewer
  4. `screenshot-4-popup.png` — settings popup

  **Stale as of 2.4.0** — all four predate whole-page translation and the
  popup's connection check, and the store's first screenshot is the one a
  browser shows in search results. Re-shoot before submitting, leading with a
  bilingual whole-page capture. Keep them honest: real runs against a live
  local model, no mock-ups.

- Promo tile (440×280): optional; not provided.

## Privacy tab answers

- **Single purpose:** Translate web page and PDF content — a user selection or
  the whole page — using the user's own local LLM server (Ollama), with
  optional saving of the result as a note.
- **Permission justifications:**
  - `storage` — persist user settings (Ollama server URL, model, target
    language, Obsidian vault/folder, enrichment toggle).
  - `activeTab` — interact with the currently active tab when the user invokes
    the selection UI, asks for a whole-page translation, or opens a local PDF
    in the bundled viewer.
  - Host permission `<all_urls>` — the selection-translate UI must work on any
    site the user reads, and `.pdf` navigations on any host are routed into the
    bundled PDF.js viewer. Page content is read only when the user selects text
    and clicks the translate icon, or explicitly asks for the whole page.
- **Remote code:** No. All code is packaged; the only network traffic is to the
  user-configured Ollama server.
- **Data usage:** Does **not** collect or transmit any user data to the
  developer or third parties. Selected text is processed by the user's own
  Ollama server. Check "No, I do not collect user data"; certify compliance.
- **Privacy policy URL:** `https://github.com/0Smallcat0/OpenRead/blob/main/PRIVACY.md`
