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
- [~] Benchmark: N local Ollama models x latency/cost/quality — `judge.ts` written; run needs Ollama up
- [x] Vitest coverage on core (100% funcs, ~92% lines, 57 tests)
- [x] Architecture doc + streaming sequence diagram (`docs/ARCHITECTURE.md`)

### Tier 2 — packaging

- [x] README rewrite (leads with the technical story + real eval numbers)
- [ ] Demo GIF (needs a screen recording)
- [x] CHANGELOG + semver, MIT LICENSE, CONTRIBUTING, issue + PR templates
- [x] GitHub Actions CI (`.github/workflows/ci.yml`: compile + test + lint + build)
- [ ] (optional) Chrome Web Store listing / landing page

## Bugs found in v1 (fix + cite as "what I improved")

1. `viewer_init.js:2` loads `pdf.worker.js` but the file is `pdf.worker.mjs` -> worker fails.
2. `utils/zh-map.js` claims "~2800 pairs" but the string is ~200 chars repeated 4-5x;
   real coverage far lower.
3. Unconditional `面->麵`, `里->裡`, `台->臺` corruption (`界面->界麵`, `公里->公裡`). OpenCC fixes this.
4. Manifest declared unused `scripting` + `declarativeNetRequest` permissions (store-review risk). Dropped.
5. `content.js` <-> `pdf-integration.js` ~90% copy-paste duplication.

## Resume bullets (real numbers from the eval harness)

- Rebuilt a browser LLM-translation extension around a **pure, 100%-function-covered
  reliability core** (TypeScript strict, 57 Vitest tests, ~92% line coverage), separating
  all output-cleanup logic from Chrome/DOM so it is unit-testable and eval-measurable.
- Built an **offline, deterministic eval harness** that cut, on a 23-fixture set,
  **model-preamble leakage 34.8% → 0%**, **input-echo 17.4% → 0%**, and
  **Simplified-character leakage 38.1% → 0%** — before/after metrics reproducible in CI.
- Engineered **cancellation-safe SSE streaming** over MV3 service-worker ports with a
  per-request `AbortController` (removing v1's shared-global-controller race) and a
  reluctant-buffer stream assembler that strips preamble without delaying first paint.
- Replaced a buggy hand-rolled SC→TC map (corrupted `界面→界麵`, `公里→公裡`) with OpenCC
  phrase-level conversion (`s2twp`); collapsed ~90% duplicated web/PDF UI into one module.

## Deferred (need the user's key / machine — not code)

- Multi-model latency/cost/quality benchmark and live LLM-as-judge run
  (`eval/judge.ts` is written; both need a running local Ollama server).
- Demo GIF (screen recording) and optional Chrome Web Store listing.
