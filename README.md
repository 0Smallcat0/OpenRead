# OpenRead

> **Engineering reliable, _measurable_ streaming-LLM output — with translation as the vehicle.**

OpenRead is a Manifest V3 Chrome extension that translates any web page or local
PDF with a local LLM via Ollama — no key, no cloud — streaming the result in
place. The interesting part isn't calling the API — it's taming the
non-deterministic text a model emits in a latency-sensitive streaming UI, and
_proving_ the taming works.

![CI](https://github.com/0Smallcat0/OpenRead/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

---

## Demo

Select text on any page, click the floating **文**, and the
Traditional-Chinese translation streams in — here on the
[Wikipedia article for LLMs](https://en.wikipedia.org/wiki/Large_language_model),
translated by a local model:

![Web translation on Wikipedia](docs/screenshots/demo-wikipedia.png)

The same selection UI works on developer docs and on PDFs — local or remote —
through a bundled PDF.js viewer (below: MDN, and a real arXiv paper):

| Developer docs (MDN) | Research PDF (arXiv) |
| --- | --- |
| ![Translating MDN docs](docs/screenshots/demo-mdn.png) | ![Translating an arXiv PDF](docs/screenshots/demo-arxiv-pdf.png) |

Everything is configured in a small popup — a local Ollama server URL, a model,
and a target language. No account, no API key:

<p align="center">
  <img src="docs/screenshots/popup.png" alt="Popup settings" width="300" />
</p>

> All screenshots are real end-to-end runs against a local `llama3.1` via Ollama —
> captured by the browser E2E harness, not mock-ups.

## Why this exists

An LLM told to "translate this" will happily also emit a preamble
(`Sure, here is the translation:`), think out loud (`The user wants…`), echo the
input back, wrap the output in quotes, or — for a Traditional-Chinese target —
leak Simplified characters. In a streaming UI these artifacts land on screen
before you can react.

OpenRead treats that as an **engineering problem with a measurable target**. The
cleanup logic is a pure, dependency-free core, unit-tested in isolation and
scored by an offline eval harness so improvements are quantified, not vibes.

## Reliability eval

`pnpm eval` runs the pure reliability layer over a curated set of real failure
modes and reports before/after rates. Fully offline and deterministic — no
Ollama server, no network — so the numbers are reproducible in CI.

| Metric                                             | Before | After    | Reduction |
| -------------------------------------------------- | ------ | -------- | --------- |
| Preamble / thinking leakage                        | 34.8%  | **0.0%** | 100%      |
| Input echo                                         | 17.4%  | **0.0%** | 100%      |
| Simplified-character leakage (Traditional targets) | 38.1%  | **0.0%** | 100%      |

_Measured over 23 curated fixtures (21 Traditional-Chinese targets). Regenerate
with `pnpm eval`; full report in [`eval/RESULTS.md`](eval/RESULTS.md)._

The pure core carries **100% function coverage and ~94% line coverage** across
120 unit tests (`pnpm test:cov`).

## Which local model? — live benchmark

The offline eval freezes model output to score the pipeline; `pnpm bench`
asks the opposite question against live models: **which model should you run,
and what does each design choice cost?** 27 curated EN→zh-TW fixtures with
Taiwan-convention references × 4 models × 2 prompt conditions, streamed
through the exact shipped pipeline and scored with sacrebleu-cross-validated
chrF, artifact detectors, latency probes, and a schema-constrained LLM judge —
itself calibrated against 40 blind human labels: quadratic-weighted Cohen's κ
0.53 on adequacy (moderate — usable), 0.21–0.27 on fluency/localization (weak
— so quality claims lean on chrF + adequacy, and the judge's localization
scores are treated as an upper bound; [`eval/AGREEMENT.md`](eval/AGREEMENT.md)).

| Model | chrF ↑ | TTFT-UI p50 | Tokens/s | Verdict |
| --- | --- | --- | --- | --- |
| **qwen3** (default) | **46.3** | **451 ms** | 48 | best quality/latency balance |
| qwen3.5 | 43.4 | 730 ms | 42 | no chrF edge, 1.6× the wait |
| llama3.1 | 31.6 | 532 ms | 49 | fast, but ~13 chrF behind |
| deepseek-r1:8b | 36.6 | 6,353 ms | — | 6-second "thinking tax" — wrong workload |

_Engineered-prompt condition, seed 42; full tables in
[`eval/BENCHMARK-RESULTS.md`](eval/BENCHMARK-RESULTS.md), methodology and
limitations in [`docs/BENCHMARK.md`](docs/BENCHMARK.md)._

Two findings worth calling out:

- **The benchmark caught a product-breaking bug.** Through Ollama's
  OpenAI-compat endpoint, reasoning models can spend the *entire* generation
  on hidden chain-of-thought — one fixture: 99 s, 4,055 tokens, zero visible
  characters. The client now uses the native `/api/chat` with `think: false`
  (same fixture: 1.6 s).
- **The reliability layer is a measured tradeoff, not free.** It zeroes
  preamble on dirty outputs and halves deepseek-r1's Simplified leakage, but
  costs ~200 ms of first paint and a fraction of a chrF point on clean
  outputs — numbers, not vibes, either way.

## How it works

- **Reliability layer** ([`src/core/sanitize.ts`](src/core/sanitize.ts)) —
  anchored preamble/thinking filters, echo removal, quote unwrapping.
- **Streaming assembler** ([`src/core/stream.ts`](src/core/stream.ts)) — a
  "reluctant buffer" holds only the opening tokens (where preamble hides) so the
  translation still paints fast, then streams the rest straight through.
- **Taiwan localization** ([`src/core/zh-convert.ts`](src/core/zh-convert.ts)) —
  OpenCC `s2twp` phrase-level Simplified→Traditional conversion, replacing v1's
  hand-rolled character map that corrupted `界面→界麵` and `公里→公裡`.
- **Same-language short-circuit**
  ([`src/core/language.ts`](src/core/language.ts)) — script detection skips the
  API entirely when a selection is already in the target language (zero latency,
  zero cost).
- **Cancellation-safe streaming**
  ([`src/api/ollama.ts`](src/api/ollama.ts) +
  [`src/entrypoints/background.ts`](src/entrypoints/background.ts)) — each
  request owns an `AbortController`; a new selection or a closed panel aborts
  the in-flight stream with no shared mutable state to race on.
- **Reasoning-model safe** — the client uses Ollama's native `/api/chat` with
  `think: false` because the benchmark caught the OpenAI-compat endpoint
  burning entire generations as hidden reasoning with zero visible output on
  qwen3-family and deepseek-r1 models
  ([`docs/BENCHMARK.md`](docs/BENCHMARK.md) §6). Requires Ollama ≥ 0.9.
- **Fully local** — no cloud, no key, no telemetry. The selected text is sent
  only to a local Ollama server on your machine; nothing leaves your device.
  The server URL lives in `chrome.storage` and is read only by the background
  worker; it never travels over the message bus.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module map and the
streaming sequence diagram.

## Capture to Obsidian

Reading is only half the loop — OpenRead also turns any translated selection
into a note in your [Obsidian](https://obsidian.md) vault. Once a translation
streams in, a **＋ 儲存到 Obsidian** button drops a Markdown note — original,
translation, and a machine-readable YAML header — straight into your vault via
an `obsidian://new` URI. No extra permissions, no server; notes too large for a
protocol-handler URL fall back to the clipboard.

| Translate + one-tap capture on any page | …lands as a note in your Obsidian vault |
| :---: | :---: |
| ![Inline translation and the save-to-Obsidian button on MDN](docs/screenshots/capture-saved.png) | ![The captured note in Obsidian, its frontmatter rendered as Properties](docs/screenshots/capture-obsidian.png) |

<sub>And the exact Markdown OpenRead writes — the frontmatter is the `status: raw` handoff contract:</sub>

![Generated capture note](docs/screenshots/capture-note.png)

That header is a deliberate **handoff contract**. Every note is written
`status: raw`, so a stronger downstream model (a "second brain") can query the
unprocessed captures, synthesize them, and flip the flag. OpenRead does the
cheap, reliable part on-device and defers the expensive part — rather than
re-implementing a knowledge base it has no business owning.

Optionally, a small local model can pre-label a capture with a title, summary,
and tags. That pipeline is defense-in-depth, and every layer is _measured_:

| Layer | Evidence |
| --- | --- |
| Schema-constrained decoding (Ollama `format`) | took the one imperfect model (deepseek-r1) from 93.3% → **100%** usable metadata at zero latency cost — live study over 4 models × 16 excerpts ([`eval/STRUCTURED-RESULTS.md`](eval/STRUCTURED-RESULTS.md)) |
| Tolerant `parseEnrichResponse` | salvages 71.4% vs naive parsing's 42.9% on an archive of 14 hostile reply shapes from older/thinking models ([`eval/CAPTURE-RESULTS.md`](eval/CAPTURE-RESULTS.md)); today it mostly does content hygiene — length caps, tag normalisation |
| `status: raw` handoff | even a perfect-looking label is garnish; the raw capture stays the source of truth |

The live study also produced an honest negative result: with the shipped
prompt, temperature 0, and thinking disabled, **modern small models emit
clean JSON ~100% of the time** — the dramatic salvage rates belong to older
model generations. Enrichment stays off by default anyway: it adds a
model round-trip per capture, and reasoning-class models take ~45 s to label
a paragraph (measured), which no capture UX survives.

Set your vault, capture folder, and the enrichment toggle in the popup; leave
the vault blank to use whichever vault is currently open.

## Install (from source)

```bash
pnpm install
pnpm build
```

Then in Chrome: open `chrome://extensions`, enable **Developer mode**, click
**Load unpacked**, and select `.output/chrome-mv3`.

### Ollama setup

OpenRead translates through a local [Ollama](https://ollama.com/) server — no
API key required.

1. [Install Ollama](https://ollama.com/).
2. Pull a model: `ollama pull qwen3` (the benchmarked default; see
   [`docs/BENCHMARK.md`](docs/BENCHMARK.md) for how it was chosen).
3. Start the server: `ollama serve`.
4. Allow the extension's origin through Ollama's CORS by setting
   `OLLAMA_ORIGINS=chrome-extension://*` before starting it:
   - **macOS**: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"`, then restart Ollama
   - **Linux**: set `OLLAMA_ORIGINS=chrome-extension://*` in the systemd service or shell env, then restart Ollama
   - **Windows**: set a user environment variable `OLLAMA_ORIGINS=chrome-extension://*`, then restart Ollama

Open the toolbar popup and set the Ollama server URL (default
`http://localhost:11434`) and model (default `qwen3:latest`), plus a target
language.

## Usage

- **Web pages** — select text; click the floating **文** icon; the translation
  streams into a panel.
- **PDFs** — navigate to any `.pdf`; OpenRead redirects it into a bundled
  PDF.js viewer where the same selection translator works on the rendered text.

## Development

```bash
pnpm dev          # HMR dev build (Chrome); pnpm dev:firefox for Firefox
pnpm test         # Vitest unit suite
pnpm test:cov     # …with coverage
pnpm eval         # reliability eval -> eval/RESULTS.md
pnpm eval:capture # capture-enrichment eval -> eval/CAPTURE-RESULTS.md
pnpm compile      # tsc --noEmit (strict)
pnpm lint         # ESLint
pnpm build        # production build -> .output/chrome-mv3
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow.

## Tech stack

TypeScript (strict) · [WXT](https://wxt.dev) · Vitest · ESLint + Prettier ·
[OpenCC](https://github.com/nk2028/opencc-js) · Ollama · GitHub Actions

## License

[MIT](LICENSE)
