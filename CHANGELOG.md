# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.14] - 2026-07-26

### Removed

- **The manual UI harness added in 2.2.11.** It existed to work around a
  limitation that no longer applies: at the time the built extension could not
  be loaded into a browser, so the only way to see the selection UI render was
  to mount the module on a plain page. Loading the extension into Chrome for
  Testing removed that constraint, and every finding since — the page-aware
  palette, the icon reappearing over the panel, the 403 message, the PDF
  startup sweep — came from the real extension rather than the harness, which
  has not been used since the day it was written. Keeping an unused second way
  to exercise the same module is maintenance surface with no reader. Goes with
  it: the `harness` script, the direct `vite` dependency it needed, and the
  launch configuration that only pointed at it.

## [2.2.13] - 2026-07-26

### Fixed

- **A PDF opened as the browser's startup page stayed in Chrome's own viewer.**
  `chrome.tabs.onUpdated` only sees navigations that happen while the MV3 worker
  is alive; launch the browser straight onto a PDF — a restored session, or a
  `.pdf` link clicked from outside Chrome — and the navigation is already past
  `loading` before the worker starts. Measured in a real browser: launching with
  a PDF as the startup page landed in the built-in viewer every time, while
  browsing first and then opening the same PDF worked. The worker now sweeps the
  open tabs on `onStartup` and `onInstalled`, honouring the same file-scheme
  permission check and the same don't-redirect-the-viewer guard.

## [2.2.12] - 2026-07-26

Found by running the **real extension** in a real browser — loaded from the
command line into a throwaway profile, driven over CDP with real mouse input,
against a real page and a real Ollama. The unit tests were green throughout;
none of these three is reachable from jsdom.

### Fixed

- **The panel picked its colours from the operating system, not the page.**
  `palette()` asked `prefers-color-scheme`, which answers a different question
  than the one its own comment posed. Most sites are light-only whatever the OS
  preference says, so a dark system theme put a dark panel on a light page —
  precisely the mismatch the palette exists to prevent. It now samples the
  background actually painted behind the selection and falls back to the media
  query only when the whole chain is transparent.
- **Clicking the 文 button made it come back on top of the panel it opened.**
  The button acts on `mousedown`; the `mouseup` that follows still reaches the
  document, where it read as "the user finished selecting" — and the selection
  is of course still there, so the icon was redrawn over the panel. A
  synthesised `mousedown` never produces the matching `mouseup`, which is why
  the suite never saw it.
- **The likeliest first-run failure said nothing useful.** Ollama refuses
  requests from origins it was not told about, and a browser extension is
  always such an origin; it answers **403 with an empty body**, which surfaced
  as `⚠️ Ollama 403: {}`. The client now names the cause and the setting
  (`OLLAMA_ORIGINS="chrome-extension://*"`). The actionable wording already
  existed for the network-failure case and simply never covered this one.

## [2.2.11] - 2026-07-26

Everything below was found by running the UI in a real browser. The unit tests
were green throughout — jsdom computes no geometry, so no test in the suite
could have seen any of it.

### Added

- **A manual harness for the selection UI** (`pnpm harness`). It mounts
  `mountSelectionTranslator` on a plain Vite page with `chrome` stubbed and the
  translation faked, so the parts that only exist once a rendering engine is
  involved — layout, focus, `prefers-color-scheme` — can be exercised by hand.
  Not the extension: the shortcut and the content-script wiring still need the
  real thing loaded.

### Fixed

- **The panel hung off the left edge of a narrow viewport.** `min-width` and
  `max-width` are content-box by default, so the 30px of horizontal padding was
  added on top of the 90vw cap: measured at **370px wide in a 375px viewport**,
  and once the right-edge branch pushed it back it sat at **left: -14px**. With
  `box-sizing: border-box` it measures 338px and sits at left: 18px. Desktop is
  unchanged (400px, on-screen in both the normal and right-edge cases).

### Verified

- Enter on the 文 button opens the panel and **moves focus into it**; Escape
  closes both panel and icon; the panel is a `role="dialog"` whose content is an
  `aria-live` region — all confirmed with real key events, not synthesised ones.
- The dark palette actually applies under `prefers-color-scheme: dark`
  (`#1f1f1f` / `#e8e8e8`), and its contrast ratios were **computed from the
  rendered colours** rather than trusted from a comment: body text 13.45:1,
  close button 6.27:1.

## [2.2.10] - 2026-07-26

### Added

- **`pnpm bench -- --repipe`** re-scores the recorded benchmark generations
  through the current pipeline without asking the models for new ones. The
  checkpoint already stored what the model emitted separately from what the
  pipeline made of it, so a change to the assembler can be measured against
  identical model output — the pipeline's effect isolated from sampling noise.
  It also drops the judge scores it invalidated, so a report can never mix
  scores from two different pipelines.

### Changed

- **The benchmark now describes the shipped pipeline.** Its numbers were
  produced by whatever was checked out on 2026-07-10 — before phrase-safe
  conversion, the corrected script markers, the adaptive buffer and echo
  removal. Re-piped: 17 of 216 generations changed. Preamble, echo and
  Simplified leakage are now **0% across every model × prompt cell** after the
  pipeline (deepseek-r1's naive-prompt Simplified leakage: 14.8% → 0%), and the
  pipeline **adds** chrF on six of eight cells rather than costing it —
  llama3.1's naive prompt moved from −0.3 to +1.0, with −0.1 the worst cell.
  The "reliability costs 0.3–0.5 chrF" claim in the README and
  `docs/BENCHMARK.md` was true of the old assembler and is now retired.

## [2.2.9] - 2026-07-26

### Added

- **Tests for the background service worker**, the last part of the extension
  with real behaviour and no coverage. It is thin but not trivial: it owns the
  streaming broker's cancellation, the only place a network failure becomes
  something a user can act on, PDF routing, and the keyboard command. Twenty
  cases drive the listeners it registers — chunk relay and `done`, the base URL
  being read from storage rather than taken off the message bus, a `TypeError`
  turning into the "is Ollama running, is `OLLAMA_ORIGINS` set" message, other
  errors passing through verbatim, an abort staying silent so a replaced
  selection does not put a warning in the panel, a new request aborting the
  previous one, a disconnect aborting in-flight work, `.pdf` redirection
  including the file-scheme permission check and the don't-redirect-the-viewer
  case, the command reaching the active tab and surviving a tab with no
  listener, and the enrichment round-trip falling back to `null` so a capture is
  never lost to it.
- Coverage now includes `src/entrypoints/background.ts`: **211 tests**, 95%
  function and 94% line coverage overall, with the background worker itself at
  100% function / 98% line.

## [2.2.8] - 2026-07-26

### Added

- **A keyboard shortcut — `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS) — translates
  the current selection.** Remappable at `chrome://extensions/shortcuts`, and it
  needs no extra permission. It exists because the floating 文 icon is not a
  route a keyboard user can take: reaching it means tabbing to an element
  appended at the end of `<body>`, past everything else on the page.

### Fixed

- **The 文 icon never appeared for a selection made with the keyboard.**
  Shift+Arrow, Shift+Home/End/PageUp/PageDown and Ctrl+A change the selection
  without ever producing a `mouseup`, which was the only thing that offered the
  icon — so the button's own keyboard support, added in 2.2.2, was unreachable
  by exactly the people who needed it. Those keys now offer the icon too.

## [2.2.7] - 2026-07-26

The offline eval was scoring a code path the product does not run. Fixing the
measurement exposed real leaks in the shipped one.

### Fixed

- **The reluctant buffer flushed mid-artifact.** Twelve characters is shorter
  than the things it exists to catch, so `Here is the translation: 關閉前…`
  flushed at `Here is the`, the cleaner never saw the colon it splits on, and
  `translation: 關閉前…` streamed to the panel. Likewise `<think>The user is
asking…` flushed at `<think>The u` and leaked the rest of the thinking. The
  hold is now **adaptive**: it extends only while a preamble has not reached its
  delimiter, a `<think>` block is unclosed, or an echo of the selection is still
  arriving — and is capped at 400 characters so first paint cannot stall.
  Measured on real qwen3 output, **clean translations are held for exactly as
  many characters as before** (15, 15, 15, 3, 5 — identical with the check on
  and off); only artifact-shaped openings wait longer.
- **Input echo was never removed in production.** `stripEcho` lived in
  `cleanTranslationOutput`, which the streaming path does not call — the panel
  showed `Hello world 你好世界` in full. `StreamAssembler` now takes the source
  and strips a leading echo of it, along with the whitespace the removal leaves
  behind.
- **Quote unwrapping never ran either.** The cleaner was invoked only when
  `isAIThinking` fired; it now runs unconditionally on the opening, which is a
  no-op when no narration pattern matches.
- A line break falling exactly at the flush point is preserved. Both cleaners
  trim, so a multi-line translation used to lose its first newline.

### Changed

- **`pnpm eval` replays fixtures through the shipped `StreamAssembler`** in
  3-character deltas instead of calling a whole-output cleaner the extension
  never executes. Scored against the real path, the previous code left 8.7%
  preamble and 8.7% echo — both of which the eval reported as 0%. With the fixes
  above the shipped path reaches 0% on all three metrics, and the number now
  describes the product.

## [2.2.6] - 2026-07-26

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
