# OpenRead Benchmark — Methodology & Findings

A local, reproducible evaluation of streaming-LLM translation quality,
reliability, and latency across four on-device models — plus a controlled
study of structured-output strategies for small models. Everything runs
against the **exact shipped code path**, so the numbers describe the product,
not a lab approximation of it.

> Headline results live in the generated reports:
> [`eval/BENCHMARK-RESULTS.md`](../eval/BENCHMARK-RESULTS.md),
> [`eval/STRUCTURED-RESULTS.md`](../eval/STRUCTURED-RESULTS.md), and
> [`eval/AGREEMENT.md`](../eval/AGREEMENT.md). This document explains how they
> were produced and what they mean.

## 1. Why benchmark a translator extension?

OpenRead's thesis is that streaming-LLM output is an engineering material with
measurable failure modes — preamble, input echo, Simplified-character leakage,
hidden reasoning — not just "AI magic". The offline eval (`pnpm eval`) proves
the sanitizer removes artifacts from a *fixed* fixture set; this benchmark
asks the live questions the offline harness cannot:

1. **Quality** — which local model translates EN→zh-TW best, and how much does
   prompt engineering move it?
2. **Reliability** — how often do artifacts appear in *fresh* generations, and
   does the shipped pipeline still catch them?
3. **Latency** — what does the user actually wait, and what does the
   reliability layer cost in time-to-first-paint?
4. **Trust** — is the LLM judge itself calibrated against a human?

## 2. Setup

| | |
| --- | --- |
| Hardware | NVIDIA GeForce RTX 4060 Laptop GPU, 8 GB VRAM |
| Server | Ollama 0.31.1, Windows 11 |
| Models | `qwen3.5:latest` (6.6 GB), `qwen3:latest` (5.2 GB), `llama3.1:latest` (4.9 GB), `deepseek-r1:8b` (5.2 GB) |
| Decoding | temperature 0.3 (the extension's first-attempt setting), fixed seed 42 |
| Endpoint | native `/api/chat`, `think: false` — the shipped client path |
| Judge | `qwen3.5:latest`, temperature 0, JSON-schema-constrained output |

**Product fidelity.** The runner imports the extension's own modules —
`buildMessages` (prompt), `extractChunk` (stream parsing), `StreamAssembler`
(reluctant buffer), OpenCC `s2twp` — so a benchmark cell exercises the same
bytes a user's selection does. The only deviations are a fixed seed and timing
probes.

## 3. Dataset

[`eval/dataset/bench-fixtures.json`](../eval/dataset/bench-fixtures.json):
**27 EN→zh-TW segments** across six domains — news (4), tech-docs (5),
academic (4), UI strings (4), colloquial (4), and adversarial "tricky" items
(6): idioms that must not be translated literally, units/numbers/inline code
that must survive verbatim, and a multi-sentence streaming stress paragraph.

Each fixture carries a reference translation written in deliberate **Taiwan
conventions** — 升息一碼, 執行緒, 連接埠, 工作階段, 晶片 — so the metric can
distinguish "Traditional script" from "actually Taiwanese usage", which is
exactly the distinction v1's hand-rolled converter failed at.

*Provenance & limitation:* references were drafted with a frontier LLM and
human-reviewed; they represent one good translation, not the only one. chrF
against a single reference therefore under-credits legitimate paraphrases —
fine for *comparing systems on the same footing*, not an absolute quality
scale.

## 4. Metrics

- **chrF** ([`eval/bench/chrf.ts`](../eval/bench/chrf.ts)) — character
  n-gram F-score (n=1–6, β=2), the standard reference-based surface metric
  for Chinese targets because it needs no word segmenter. Our implementation
  is cross-validated against Python `sacrebleu` 2.6.0 to six decimal places
  (see `chrf.test.ts`); corpus scores aggregate n-gram statistics, not
  per-segment averages.
- **Artifact rates** — the same detectors the offline eval and the production
  pipeline share (`hasPreamble`, `hasEcho`, `hasSimplifiedLeak`), applied to
  both the raw model output and the shipped-pipeline output of every cell.
- **TTFT-net vs TTFT-UI** — ms from request start to the first content token,
  vs to the first text the panel would actually paint. The gap prices the
  reluctant buffer; for reasoning models the wait is dominated by hidden
  thinking, which the runner tracks separately (`thinkingChars`).
- **Tokens/s** — generated tokens over generation time, from the final
  NDJSON chunk's `eval_count`.
- **LLM judge** — reference-based grading on three 1–5 axes: adequacy,
  fluency, Taiwan localization. Constrained decoding (`format` = JSON schema)
  + `think: false` + temperature 0 make it cheap and deterministic. Judged
  end-to-end experiences: the `naive` baseline's raw output vs the
  `engineered` condition's shipped-pipeline output.

### Judge calibration

A judge is only evidence if it tracks human judgement.
`pnpm bench:agreement -- --make-page` samples 40 judged items (seeded,
stratified across model × condition, model identity hidden) into a
self-contained labeling page; a human rates them on the same rubric, and
`pnpm bench:agreement` reports raw agreement plus unweighted and
quadratically-weighted Cohen's κ per axis
([`eval/bench/kappa.ts`](../eval/bench/kappa.ts), verified against textbook
cases). Results land in [`eval/AGREEMENT.md`](../eval/AGREEMENT.md).

## 5. Conditions

| Condition | Prompt | Pipeline |
| --- | --- | --- |
| `naive` | one bare user instruction, no system prompt, no few-shot | scored raw *and* through the pipeline |
| `engineered` | the shipped `buildMessages`: role/rules system prompt + anti-echo few-shot | scored raw *and* through the pipeline |

Two generations per model per fixture; the pipeline variants are free
(post-processing the same stream), so the matrix separates *prompting* gains
from *pipeline* gains.

## 6. Found bug: reasoning models × the OpenAI-compat endpoint

The first full run produced a product-breaking discovery. Through Ollama's
OpenAI-compat `/v1/chat/completions` — the endpoint v2.1 shipped with —
**reasoning models can emit their entire generation as `reasoning` while
`content` stays empty**: `qwen3.5` spent 99 s and 4,055 tokens on one fixture
and returned zero visible characters. Passing `think: false` through `/v1`
did not disable it. The extension would have shown users a spinner and then
nothing.

The fix, shipped in the same change as this benchmark: migrate the client to
the **native `/api/chat`** endpoint with `think: false` —

- hybrid thinkers (qwen3 family) actually stop thinking: the same qwen3
  fixture went from **99 s / empty** to **1.6 s / TTFT 282 ms**;
- non-thinkers (llama3.1) tolerate the flag as a no-op;
- models that cannot stop thinking (deepseek-r1) still keep reasoning out of
  `content` — they pay a "thinking tax" in TTFT, which the latency table
  quantifies, but the answer arrives clean.

This is the benchmark working as intended: the harness exists to catch
exactly the class of failure a quick manual test misses.

## 7. Results

See [`eval/BENCHMARK-RESULTS.md`](../eval/BENCHMARK-RESULTS.md) for the full
tables (quality, artifacts, latency, judge scores). Summary of what to look
for:

<!-- BENCH-SUMMARY:START -->
Run of 2026-07-10 — 216/216 generations, 0 errors, all cells judged:

- **`qwen3` (engineered prompt) is the quality/latency sweet spot**: corpus
  chrF 46.3, TTFT-UI p50 451 ms, ~48 tokens/s. `qwen3.5` matches it on judge
  scores but is no better on chrF and pays ~1.6× the TTFT. It is now the
  extension's default model.
- **Prompt engineering is model-dependent, not free quality**: the shipped
  system-prompt + few-shot lifts qwen3 (+1.7 chrF raw) and deepseek-r1
  (+3.6), does nothing for qwen3.5, and nothing for llama3.1 — which sits
  ~13 chrF below the qwen family regardless of prompting.
- **The reliability layer's value concentrates on dirty outputs.** It zeroed
  llama3.1's naive-prompt preamble (7.4% → 0%) and halved deepseek-r1's
  Simplified leakage (18.5% → 7.4%), while on already-clean outputs it costs
  a small amount of legitimate text (llama3.1: −0.3 to −0.5 chrF) plus
  ~200 ms of TTFT — the reluctant buffer's measured price.
- **Residual Simplified leakage (~7%) survives the pipeline** on several
  models. Consistent with the per-delta OpenCC transform being unable to
  convert a phrase split across two stream chunks — a concrete, testable
  follow-up for the streaming layer.
- **The thinking tax is disqualifying for interactive use**: deepseek-r1's
  TTFT is 6.4–6.6 **seconds** (vs 0.3–0.8 s for everything else) because it
  cannot stop reasoning even with `think: false`; its tokens/s figure is
  inflated for the same reason (`eval_count` includes hidden thinking
  tokens). Quality-wise it also trails the qwen family. Fine model, wrong
  workload.
- **Judge scores rank models the same way chrF does** (qwen family >
  llama3.1 ≈ deepseek-r1 on adequacy), with one caveat: `naive` conditions
  are judged on raw output and `engineered` on pipeline output, so the small,
  consistent adequacy dip under `engineered` partly reflects the pipeline's
  clipping, and qwen3.5 grading its own family invites bias — hence the human
  calibration step (§4).
<!-- BENCH-SUMMARY:END -->

## 8. Structured-output study

The capture feature optionally asks a small model for `{title, summary,
tags}` metadata. The earlier offline eval showed a robust salvage parser
lifts usable-metadata rate from 42.9% to 71.4% over 14 canned reply shapes;
the live study ([`eval/STRUCTURED-RESULTS.md`](../eval/STRUCTURED-RESULTS.md))
asks the next question: **does schema-constrained decoding beat prompt
engineering + robust parsing on fresh generations?**

Design: 16 realistic capture excerpts (EN / zh-TW / mixed) × 4 models × 2
generation conditions (`prompt` = shipped prompt rules; `schema` = the same
request with Ollama's `format` JSON schema), each raw reply scored by naive
`JSON.parse`, by the shipped `parseEnrichResponse`, and by a failure-shape
taxonomy ([`eval/structured/taxonomy.ts`](../eval/structured/taxonomy.ts)) —
clean / fenced / prose-wrapped / thinking-contaminated / truncated / no-JSON.

<!-- STRUCTURED-SUMMARY:START -->
Run of 2026-07-10 — 128 generations, and the result is an honest surprise:

- **The 2024-era failure modes did not reproduce.** With the shipped prompt,
  temperature 0, and `think: false` on the native endpoint, all four models
  returned clean, directly-parseable JSON on essentially every reply (naive
  `JSON.parse`: 100%). The fenced/preamble/trailing-prose shapes that
  motivated the salvage parser — and its offline 42.9% → 71.4% rescue rate on
  archived reply shapes — belong mostly to older models and to
  thinking-contaminated output, which the client migration itself eliminated.
- **Schema-constrained decoding still closes the last tail at zero cost**:
  deepseek-r1 was the only imperfect model (93.3% all-three-fields, one
  timed-out cell) and `format` took it to 100%/0 errors with identical median
  latency. The extension now sends the schema on every enrichment request;
  `parseEnrichResponse` remains as the content-hygiene layer (length caps,
  tag normalisation) rather than a JSON rescue.
- **The thinking tax again**: deepseek-r1's median enrichment is ~45 s
  (thinking through the whole labeling task) vs 1.1–1.8 s for the others —
  reinforcing the benchmark's conclusion that reasoning models are the wrong
  tool for interactive assist features, independent of output shape.
<!-- STRUCTURED-SUMMARY:END -->

## 9. Limitations

- **Single seed, one generation per cell** — differences of a point or two of
  chrF are noise; read the big gaps.
- **Judge family bias** — qwen3.5 judges its own relatives; mitigated by
  reference-based grading and the human-calibration protocol, not eliminated.
- **Single-reference chrF** under-credits paraphrase (§3).
- **Latency is machine-specific** (RTX 4060 Laptop, 8 GB); relative
  comparisons are the point.
- **n = 27 fixtures** — domain-level breakdowns are indicative, not
  significant.

## 10. Reproduce

```bash
ollama serve                      # any Ollama ≥ 0.9 with the four models pulled
pnpm bench                        # matrix + judge + eval/BENCHMARK-RESULTS.md (~30–60 min)
pnpm eval:structured              # structured-output study (~10 min)
pnpm bench:agreement -- --make-page   # then rate eval/results/labeling.html
pnpm bench:agreement              # κ judge↔human -> eval/AGREEMENT.md
```

Both runners checkpoint after every cell (`eval/results/*.json`) and resume;
`--report-only` regenerates reports without touching the GPU. The offline
gates (`pnpm eval`, `pnpm eval:capture`, `pnpm test`) stay network-free and
deterministic for CI.
