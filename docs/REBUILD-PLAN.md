# OpenRead v2 — Rebuild Plan

> Living roadmap for turning the v1 hobby extension into a portfolio-grade,
> evaluation-driven project. Target audience: **grad-school (AI/research) + industry SWE**.

## Positioning (the "angle")

Not "another immersive-translate clone." The headline is:

> **Engineering reliable, _measurable_ streaming-LLM output — with translation as the vehicle.**

The hard part of an LLM app is not calling the API; it's taming the non-deterministic
garbage it emits, in a latency-sensitive streaming UI, and _proving_ you did. That is
the story v1 already half-tells — v2 makes it explicit and quantified.

### Pillars

1. **LLM output reliability layer** — anti-preamble filtering, streaming prefix buffer,
   echo detection, few-shot anti-echo, temperature-escalating retry.
2. **Evaluation harness** — bilingual test set + LLM-as-judge + Simplified-leakage
   detector → before/after metrics. Turns "I built it" into "I built it and measured it."
3. **Streaming MV3 architecture** — service-worker ports, cancellation-safe SSE, race handling.
4. **Taiwan localization correctness** — replace v1's buggy hand-rolled SC→TC map with
   OpenCC phrase-level conversion (`s2twp`).
5. **Fully-local privacy** — inference via a local Ollama server; the selected
   text never leaves the machine, no cloud, no key, no telemetry.

## Target stack

- **WXT** (modern MV3 framework) + **TypeScript (strict)**
- **Vitest** for unit tests (the pure core is 100%-testable)
- **ESLint + Prettier**
- **OpenCC (`opencc-js`)** for SC→TC
- **GitHub Actions** CI (typecheck + test + build zip)
- Eval harness as standalone `tsx` scripts under `eval/`

## Target architecture

```
src/
  core/         # pure, framework-free, fully tested  <- the technical gold
    language.ts     detectChineseScript / shouldBypassAI      [DONE]
    sanitize.ts     cleanAIArtifacts / isAIThinking / echo    [DONE]
    zh-convert.ts   OpenCC wrapper (replaces buggy zh-map.js)  [DONE]
    prompt.ts       system prompt + few-shot engine           [DONE]
    stream.ts       StreamAssembler (reluctant-buffer logic)   [DONE]
    types.ts        shared domain types                        [DONE]
  api/
    openrouter.ts   streaming + single fetch client (typed)   [DONE]
  messaging.ts      typed port protocol (content <-> background) [DONE]
  settings.ts       chrome.storage.sync wrapper (typed)          [DONE]
  ui/
    selection.ts    shared selection icon+panel+stream client   [DONE]
  entrypoints/
    background.ts   service worker (stream broker + PDF redirect) [DONE]
    content.ts      mounts selection UI on web pages             [DONE]
    popup/          settings UI (index.html + main.ts)           [DONE]
    pdf-viewer.ts   unlisted script: selection UI on PDF.js viewer [TODO]
public/
  pdfjs/            vendored PDF.js viewer + injected translation layer
eval/
  dataset/          curated EN->TC / SC->TC sentences
  run.ts            runner -> metrics table
  judges/           LLM-as-judge + leakage detector
```

## Phased checklist

### Tier 0 — engineering debt (make it look like a real project)

- [x] Branch `rebuild/v2-wxt-ts`, `.gitignore`, `package.json`, `tsconfig.json`, `wxt.config.ts`
- [x] `src/core/language.ts` + unit tests (first proven module)
- [x] Install toolchain (WXT/Vitest/ESLint/Prettier/opencc-js) + prove tests green (50 tests)
- [x] Migrate pure core to TS: `sanitize.ts`, `zh-convert.ts` (OpenCC), `prompt.ts`, `stream.ts` + tests
- [x] Typed `api/openrouter.ts` (stream + single) + `messaging.ts` protocol (batch dropped: dead code)
- [x] WXT entrypoints: background broker + content + popup (all wired, typed)
- [x] Decide YouTube: **CUT**. Deleted `utils/youtube.js`, `utils/renderer.js`, `utils/translator.js`, `content.css` (all subtitle code)
- [x] `settings.ts` (typed sync-storage) + shared `ui/selection.ts` (the anti-dup module)
- [x] Verify `pnpm build` produces a loadable unpacked extension (web + popup + background)
- [x] **Killed the ~90% duplication**: web + PDF now share one `ui/selection.ts`
- [x] Moved `lib/pdfjs` -> `public/pdfjs`; added `pdf-viewer.ts` unlisted script; fixed worker ref (`.js` -> `.mjs`)
- [x] Deleted all v1 root files (`content.js`, `background.js`, `popup.*`, `manifest.json`, `utils/`, `assets/`, `icons/`)
- [x] Removed dead code, debug logs, `[MOCK MODE]` stubs (none survive in v2)
- [x] ESLint + Prettier clean

**Tier 0 COMPLETE.** `pnpm compile` + `pnpm test` (57) + `pnpm lint` + `pnpm build` all green.

### Tier 1 — differentiators

- [x] Eval harness: `eval/dataset/fixtures.json` + `run.ts` (metrics table) + `detectors.ts` + `judge.ts` (live, opt-in)
- [x] Benchmark: live 4 models × 2 prompts × 27 fixtures (`eval/bench/`, `docs/BENCHMARK.md`); LLM judge calibrated vs 40 human labels (`eval/AGREEMENT.md`)
- [x] Vitest coverage on core (100% funcs, ~92% lines, 57 tests)
- [x] Architecture doc + streaming sequence diagram (`docs/ARCHITECTURE.md`)

### Tier 2 — packaging

- [x] README rewrite (leads with the technical story + real eval numbers)
- [x] Demo GIF — real E2E capture (live qwen3 via Ollama), `docs/screenshots/demo.gif`
- [x] CHANGELOG + semver, MIT LICENSE, CONTRIBUTING, issue + PR templates
- [x] GitHub Actions CI (`.github/workflows/ci.yml`: compile + test + lint + build)
- [x] Chrome Web Store submission kit — `docs/store/` (listing copy, 1280×800 screenshots, guide) + `PRIVACY.md`; only the $5 dev account + upload remain manual

## Bugs found in v1 (fix + cite as "what I improved")

1. `viewer_init.js:2` loads `pdf.worker.js` but the file is `pdf.worker.mjs` -> worker fails.
2. `utils/zh-map.js` claims "~2800 pairs" but the string is ~200 chars repeated 4-5x;
   real coverage far lower.
3. Unconditional `面->麵`, `里->裡`, `台->臺` corruption (`界面->界麵`, `公里->公裡`). OpenCC fixes this.
4. Manifest declared unused `scripting` + `declarativeNetRequest` permissions (store-review risk). Dropped.
5. `content.js` <-> `pdf-integration.js` ~90% copy-paste duplication.

## Resume bullets (v2.2.0 — real numbers, EN)

- Rebuilt a browser LLM-translation extension around a **pure, 100%-function-covered
  reliability core** (TypeScript strict, 120 Vitest tests, ~94% line coverage on core),
  separating all output-cleanup logic from Chrome/DOM so it is unit-testable and
  eval-measurable; shipped with CI, an offline eval harness, and a live benchmark.
- Built an **offline, deterministic eval harness** that cut, on a curated fixture set,
  **model-preamble leakage 34.8% → 0%**, **input-echo 17.4% → 0%**, and
  **Simplified-character leakage 38.1% → 0%** — before/after metrics reproducible in CI.
- Designed a **live 4-model × 2-prompt × 27-fixture streaming benchmark**
  (chrF cross-validated against sacrebleu to 6 decimals; TTFT-network vs TTFT-UI
  probes) and used it to pick the shipped default model; **calibrated a
  schema-constrained LLM judge against 40 blind human labels** (quadratic-weighted
  Cohen's κ = 0.53 adequacy) and reported the weak dimensions (fluency 0.27,
  localization 0.21) instead of hiding them.
- **The benchmark caught a product-breaking bug**: through Ollama's OpenAI-compat
  endpoint, reasoning models can burn an entire generation as hidden chain-of-thought
  (measured: 99 s, 4,055 tokens, zero visible output). Migrated the client to the
  native `/api/chat` with `think: false` — same fixture: 1.6 s.
- Engineered **cancellation-safe streaming** over MV3 service-worker ports with a
  per-request `AbortController` (removing v1's shared-global-controller race) and a
  reluctant-buffer assembler that strips preamble without delaying first paint;
  quantified the reliability layer as a **measured tradeoff** (~200 ms first paint,
  −0.3–0.5 chrF on clean output) rather than a free win.
- Added a **capture-to-Obsidian bridge** with an eval-backed enrichment stage:
  tolerant parsing salvages 71.4% vs naive 42.9% on hostile reply shapes, and
  schema-constrained decoding takes the worst model from 93.3% → 100% usable
  metadata — plus an honest negative result (modern small models emit clean JSON
  ~100% of the time prompt-only).

## Resume bullets (v2.2.0 — zh-TW)

- 以**純函式、100% 函式覆蓋的可靠性核心**重建瀏覽器 LLM 翻譯擴充功能
  （TypeScript strict、120 個 Vitest 測試、核心行覆蓋 ~94%），將輸出清理邏輯與
  Chrome/DOM 完全解耦，使其可單元測試、可評測；附 CI、離線評測與實機基準。
- 建立**離線、確定性的評測框架**：模型前言洩漏 34.8%→0%、原文回聲 17.4%→0%、
  簡體字洩漏 38.1%→0%，前後對照數據可在 CI 重現。
- 設計 **4 模型 × 2 提示 × 27 題的實機串流基準**（chrF 與 sacrebleu 交叉驗證至
  小數 6 位；TTFT-network 與 TTFT-UI 分離量測），據此選定預設模型；並以
  **40 筆盲標人工標註校準 schema 約束的 LLM 評審**（quadratic-weighted κ：
  adequacy 0.53），同時誠實揭露弱項（fluency 0.27、localization 0.21）。
- **基準測出產品級 bug**：經 Ollama OpenAI 相容端點，推理型模型可能把整段生成
  耗在隱藏思考鏈（實測 99 秒、4,055 tokens、可見輸出 0 字）；將客戶端遷移到原生
  `/api/chat` 並設 `think: false`，同題降至 1.6 秒。
- 實作 **MV3 service worker 上可取消的串流管線**：每請求獨立 `AbortController`
  （移除 v1 全域控制器競態）、reluctant-buffer 串流組裝器在不延遲首繪的前提下
  剝除前言；並將可靠性層量化為**有代價的取捨**（首繪 +~200ms、乾淨輸出
  −0.3–0.5 chrF），而非宣稱免費優化。
- 加入 **Obsidian 擷取橋接**與評測背書的 enrich 階段：容錯解析在惡意回覆形狀上
  由 42.9% 提升到 71.4% 可用率；schema 約束解碼把最差模型從 93.3% 提到 100%；
  並保留誠實的負面結果（現代小模型 prompt-only 即 ~100% 輸出乾淨 JSON）。

## Remaining manual steps (not code)

- Chrome Web Store: create the $5 developer account and upload
  `.output/openread-<version>-chrome.zip` following
  [`docs/store/SUBMISSION.md`](store/SUBMISSION.md); after approval, add the
  store link to the README and the resume bullets.
