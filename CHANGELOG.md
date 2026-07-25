# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.6] - 2026-07-25

### Changed

- **A capture now reports "Sent to Obsidian ↗" rather than "Saved ✓".** Handing
  a URL to the OS protocol handler returns no completion signal, so if Obsidian
  is not installed — or declines the URL — nothing happens and the page is
  never told. The old wording claimed a save that the extension cannot observe.

### Removed

- **`translateText`, dead since the UI never used it.** It was exported and
  documented as "the sequential retry fallback", but nothing in `src/` called
  it; the retry added in 2.2.4 re-streams instead. Removing it also revealed
  that `cleanTranslationOutput` — which the offline eval calls "the exact
  transform the production pipeline applies" — is not reachable from any
  shipped path either. That is tracked as the next fix; the eval's numbers are
  not restated here until the code they describe actually runs.

## [2.2.5] - 2026-07-25

### Fixed

- **A selection over 5,000 characters made the 文 icon simply not appear.** No
  icon, no panel, no message — selecting a whole page or a full PDF column read
  as the extension having stopped working. The icon now appears for any
  realistic selection; above 5,000 characters the panel translates the leading
  passage and says exactly how much of the selection that was, and a capture
  records the passage that was actually translated. Measured for context: a
  4,700-character selection already takes ~21 s end to end, so translating a
  whole page silently was never the right default either.

## [2.2.4] - 2026-07-25

### Fixed

- **A generation that produced nothing left the panel frozen on
  "Translating…".** No chunk ever arrives, so the placeholder was never
  replaced — and a whitespace-only generation showed an empty box instead. This
  is a measured failure mode, not a hypothetical: the benchmark caught
  reasoning models spending an entire generation on hidden thinking. An empty
  result now retries once at a looser sampling temperature, and if the retry is
  also empty the panel names the model and suggests what to change. Transport
  errors are deliberately _not_ retried — their message is already actionable,
  and retrying a timeout would only double the wait.

### Added

- **Tests for the selection and capture UI**, the two largest untested surfaces
  in the repo and the only parts the user actually touches. They run against a
  real DOM (jsdom) with a stubbed extension port, and assert on what the panel
  shows and where a capture actually goes — streaming, empty-generation retry,
  transport errors, same-language short-circuit, Escape and close-button
  dismissal, keyboard activation and focus, ARIA wiring, the `obsidian://new`
  URI, the clipboard fallback and its `execCommand` path, and the best-effort
  enrichment round-trip.
- Coverage now includes `src/ui` alongside `src/core`: 93% function and 92%
  line coverage over 175 tests, up from 150 tests scoped to the core alone.

## [2.2.3] - 2026-07-25

Found by driving the shipped pipeline against a live Ollama over the kinds of
text a user actually selects, and watching what the panel would show.

### Fixed

- **A wedged server left the panel translating forever.** `translateStream` had
  no timeout of its own — only the port's `AbortController`, which fires on
  disconnect, not on a stalled server. Measured against a server that accepts
  the connection and then sends nothing: still pending after 20 s, and it would
  have stayed pending for the lifetime of the service worker. Both the request
  and each stream read are now bounded by an **idle** timeout
  (`DEFAULT_IDLE_TIMEOUT_MS`, 60 s) that resets on every chunk, so a long
  selection may stream for minutes while a silent server is caught in one
  window. The failure is reported as an error the user can act on rather than
  being swallowed as a cancellation.
- **A timed-out stream leaked its socket.** The reader was released but never
  cancelled, leaving the underlying connection open; it is now cancelled on
  every exit path.
- **"Translating…" no longer sits there unexplained.** The first request after
  a browser restart loads the model into VRAM — measured at **12.3 s** on the
  benchmark rig against ~180 ms for every request after it. After 4 seconds
  without a chunk the panel now says what it is waiting for and why, instead of
  reading as a hang.

## [2.2.2] - 2026-07-25

### Fixed

- **The selection UI is reachable without a mouse.** The floating 文 trigger was
  a `<div>` with a `mousedown` handler — invisible to keyboard and assistive
  tech. It is now a `<button>` with an accessible name, activated by Enter or
  Space, and the panel can be dismissed with Escape (previously only a click
  outside would close it). Keyboard activation moves focus into the panel,
  because removing the trigger would otherwise drop focus to `<body>`; mouse
  activation deliberately does not steal focus from the page.
- **Streaming translations are announced to screen readers.** The panel is a
  `role="dialog"` with an accessible name, its content is an `aria-live` region
  so text arriving chunk by chunk is actually read out, and the popup's status
  line is a live region too.
- **Contrast failures across the UI.** The panel close button (3.54:1), the
  popup's primary button label (3.68:1), the capture button, and the popup's
  input borders (1.61:1) all sat below their WCAG minimums; each is corrected,
  with the measured ratio recorded next to the value.
- **The injected panel follows the page's colour scheme.** It hardcoded a white
  sheet with near-black text, which is blinding on a dark site or dark PDF
  viewer. It now picks a contrast-checked light or dark palette, as does the
  popup's status line.
- **Panel placement near the right edge and on narrow viewports.** The
  right-edge fit test compared against 320px while the panel was 400px wide, so
  a selection near the margin was judged to fit and then overflowed; both now
  read one `PANEL_MIN_WIDTH` constant. `min-width:400px` also beat
  `max-width:min(600px,90vw)` below ~440px of viewport and pushed the panel
  off-screen; it is clamped to the same 90vw ceiling.
- **Saving settings can no longer fail silently.** A rejected `saveSettings`
  left the popup's status line blank, which reads exactly like "nothing
  happened yet"; failures now show `Save failed`.

### Changed

- Capture button and status strings are English (`＋ Save to Obsidian`,
  `Saving…`, `Saved ✓`), matching the rest of the extension chrome.
- Dropped the unused `closeButtonClass` option from `mountSelectionTranslator`;
  nothing referenced the class it applied.

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
