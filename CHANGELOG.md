# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.1] - 2026-07-25

Two correctness fixes in the Chinese-conversion path, both found by replaying
the recorded benchmark generations rather than by reading the code.

### Fixed

- **Phrase-safe streaming Simplified→Traditional conversion.** `s2twp` maps
  whole phrases, so converting each stream chunk independently mistranslated
  any phrase a chunk boundary split — `数据` + `库` became `數據庫` instead of
  `資料庫`, `端口` stayed `端口` instead of `埠`, and `下游` split in half became
  `下遊`. `TraditionalTWTransform` (`src/core/zh-convert.ts`) holds the
  ambiguous tail back until enough context has arrived, so streamed output is
  byte-identical to converting the finished text in one call. Replaying the 216
  recorded benchmark generations at chunk sizes 1–8: **13.0% of generations
  converted differently before the fix, 0.0% after.**
- **Script-marker sets are now derived from the OpenCC dictionaries** rather
  than hand-written, fixing errors in both directions. Simplified merged
  系/係/繫 and 游/遊 (among others) into single forms that are ordinary
  Traditional characters, so correct output such as `系統` and `下游` scored as
  Simplified leakage — the source of the benchmark's "residual 7.4%" — and
  `shouldBypassAI` sent already-Traditional selections to the model for no
  reason. In the other direction, common Simplified characters (发, 时, 们, 开,
  软, 机) were missing outright, so `计算机软件开发` was not detected as
  Simplified at all. `pnpm gen:markers` regenerates
  `src/core/zh-markers.generated.ts` (3,797 Simplified-only and 3,195
  Traditional-only characters); `language.test.ts` fails if it drifts from the
  installed dictionaries. Offline eval Simplified-leakage detection rises from
  38.1% to **42.9%** of applicable fixtures, still fully removed by the
  pipeline.

### Changed

- `StreamAssembler`'s `transform` option takes a stateful `ChunkTransform`
  (`push`/`end`) instead of a pure function, so a transform can hold text back
  across chunk boundaries; `StreamAssembler.end()` flushes it.

## [2.2.0] - 2026-07-10

Research-grade evaluation: live model benchmark, judge calibration, and a
structured-output study — which caught and fixed a product-breaking
reasoning-model bug.

### Added

- Live translation benchmark (`pnpm bench`): 4 local models × 2 prompt
  conditions × 27 curated EN→zh-TW fixtures with Taiwan-convention references;
  reference-based chrF (sacrebleu-cross-validated), artifact rates,
  TTFT-net/TTFT-UI latency, tokens/s, and a JSON-schema-constrained LLM judge
  → `eval/BENCHMARK-RESULTS.md`
- Judge calibration workflow (`pnpm bench:agreement`): seeded blind labeling
  page + Cohen's κ (plain & quadratic-weighted) judge↔human → `eval/AGREEMENT.md`.
  Measured over 40 human labels: weighted κ 0.526 adequacy (moderate),
  0.267 fluency / 0.213 localization (weak — judge over-lenient on Taiwan
  terminology; report reads those axes as upper bounds)
- Structured-output study (`pnpm eval:structured`): prompt-only vs
  schema-constrained decoding across 4 models × 16 realistic capture excerpts,
  with a failure-shape taxonomy → `eval/STRUCTURED-RESULTS.md`
- `docs/BENCHMARK.md` — methodology, found-bug case study, limitations

### Changed

- **Ollama client migrated from OpenAI-compat `/v1/chat/completions` to native
  `/api/chat` with `think: false`** (now requires Ollama ≥ 0.9)
- Default model `qwen2.5` → `qwen3:latest` — chosen by the benchmark (best
  chrF at the lowest TTFT of the models measured)
- Capture enrichment now uses schema-constrained decoding (Ollama `format`) —
  the study measured it closing the last unreliable tail at zero latency
  cost; the tolerant parser remains as content hygiene

### Fixed

- Reasoning models (qwen3 family, deepseek-r1) produced **no visible output**
  through the compat endpoint — chain-of-thought consumed the entire
  generation in a separate `reasoning` field (measured: 99 s / 4,055 tokens /
  0 visible characters on one fixture; 1.6 s after the fix). Found by the
  benchmark harness.

## [2.1.0] - 2026-07-09

Switch to local Ollama backend.

### Added

- Local Ollama backend (OpenAI-compatible streaming)
- Ollama server URL setting

### Changed

- Replaced the OpenRouter cloud API + API-key setting with a local Ollama server URL — translation is now fully on-device

### Removed

- The API-key input and all cloud/BYOK framing

## [2.0.0] - 2026-07-09

Complete rebuild.

### Added

- TypeScript (strict) + WXT MV3 framework
- Vitest unit suite (57 tests) + offline eval harness (`pnpm eval`)
- OpenCC `s2twp` phrase-level Simplified→Traditional conversion
- Per-request `AbortController` cancellation for streaming
- Typed message protocol
- ESLint + Prettier + GitHub Actions CI

### Changed

- Reliability layer (preamble/echo/quote stripping) extracted into a pure, tested core
- API key now read by the background worker from storage instead of travelling over the message bus

### Fixed

- PDF.js worker path (`pdf.worker.js` → `pdf.worker.mjs`) that broke local PDF rendering
- Simplified→Traditional corruption (`界面→界麵`, `公里→公裡`) from v1's hand-rolled character map

### Removed

- Unused `scripting` + `declarativeNetRequest` manifest permissions
- Orphaned YouTube subtitle code
- ~90% duplicated selection UI between web and PDF (now one shared module)

## [1.0.0]

Initial release. Hand-rolled JS extension with streaming translation for web and PDF.
