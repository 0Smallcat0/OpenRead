# OpenRead — how it is built

This is the engineering behind [the extension](../README.md): **making
streaming LLM output reliable, and _proving_ it** — with translation as the
vehicle. It used to live at the bottom of the README, where it was three
hundred lines a reader with the problem had to scroll past to reach the
download link.

Paths in this document are relative to the repository root.

## Why this is hard

An LLM told to "translate this" will happily also emit a preamble
(`Sure, here is the translation:`), think out loud (`The user wants…`), echo the
input back, wrap the output in quotes, or — for a Traditional-Chinese target —
leak Simplified characters. In a streaming UI these artifacts land on screen
before you can react.

OpenRead treats that as an **engineering problem with a measurable target**. The
cleanup logic is a pure, dependency-free core, unit-tested in isolation and
scored by an offline eval harness so improvements are quantified, not vibes.

One honest caveat, since 2.7.0 made Chrome's built-in translator the default:
**everything in this section is about the Ollama path.** Chrome ships a
dedicated translation model, and a dedicated translation model does not emit a
preamble, think out loud, or echo its input — so the reliability layer has
nothing to clean up on the default path. It is still load-bearing for anyone
who switches to a local LLM, which is where those artifacts come from and why
the layer was built. Saying otherwise would be claiming credit for work the
default engine never needs.

## Reliability eval

`pnpm eval` replays a curated set of real failure modes through the **shipped
streaming pipeline** and reports before/after rates. Fully offline and
deterministic — no Ollama server, no network — so the numbers are reproducible
in CI. Deltas are replayed in 3-character slices, so chunk boundaries land
mid-artifact exactly as they do in a live stream.

| Metric                                             | Before | After    | Reduction |
| -------------------------------------------------- | ------ | -------- | --------- |
| Preamble / thinking leakage                        | 34.8%  | **0.0%** | 100%      |
| Input echo                                         | 17.4%  | **0.0%** | 100%      |
| Simplified-character leakage (Traditional targets) | 42.9%  | **0.0%** | 100%      |

_Measured over 23 curated fixtures (21 Traditional-Chinese targets). Regenerate
with `pnpm eval`; full report in [`eval/RESULTS.md`](../eval/RESULTS.md)._

**491 unit tests** cover everything with real behaviour (`pnpm test:cov`): the
pure core at **100% function / 97% line** coverage, the selection and capture UI
driven through jsdom with a stubbed extension port, and the background worker —
which owns cancellation, error translation and PDF routing. Overall: 92%
function, 95% line.

## Which local model?

The offline eval freezes model output to score the pipeline; `pnpm bench`
asks the opposite question against live models: **which model should you run,
and what does each design choice cost?** 27 curated EN→zh-TW fixtures with
Taiwan-convention references × 4 models × 2 prompt conditions, streamed
through the exact shipped pipeline and scored with sacrebleu-cross-validated
chrF, artifact detectors, latency probes, and a schema-constrained LLM judge —
itself calibrated against 40 blind human labels: quadratic-weighted Cohen's κ
0.53 on adequacy (moderate — usable), 0.21–0.27 on fluency/localization (weak
— so quality claims lean on chrF + adequacy, and the judge's localization
scores are treated as an upper bound; [`eval/AGREEMENT.md`](../eval/AGREEMENT.md)).

| Model               | chrF ↑   | TTFT-UI p50 | Tokens/s | Verdict                                  |
| ------------------- | -------- | ----------- | -------- | ---------------------------------------- |
| **qwen3** (default) | **46.4** | **451 ms**  | 48       | best quality/latency balance             |
| qwen3.5             | 43.4     | 730 ms      | 42       | no chrF edge, 1.6× the wait              |
| llama3.1            | 31.9     | 532 ms      | 49       | fast, but ~13 chrF behind                |
| deepseek-r1:8b      | 36.4     | 6,353 ms    | —        | 6-second "thinking tax" — wrong workload |

_Engineered-prompt condition, seed 42; full tables in
[`eval/BENCHMARK-RESULTS.md`](../eval/BENCHMARK-RESULTS.md), methodology and
limitations in [`docs/BENCHMARK.md`](BENCHMARK.md)._

Three findings worth calling out:

- **The benchmark caught a product-breaking bug.** Through Ollama's
  OpenAI-compat endpoint, reasoning models can spend the _entire_ generation
  on hidden chain-of-thought — one fixture: 99 s, 4,055 tokens, zero visible
  characters. The client now uses the native `/api/chat` with `think: false`
  (same fixture: 1.6 s).
- **The reliability layer stopped being a tradeoff once it was fixed.** It
  zeroes preamble on dirty outputs and deepseek-r1's Simplified leakage
  (14.8% → 0%), and now _adds_ chrF on six of eight model × prompt cells —
  llama3.1's naive prompt went from −0.3 to **+1.0** after the streaming
  assembler stopped flushing mid-artifact. Its remaining price is ~200 ms of
  first paint. Same recorded generations, re-scored through the current
  pipeline (`pnpm bench -- --repipe`), so the change is the code, not sampling.
- **The eval was scoring a function the product does not call.** `pnpm eval`
  ran `cleanTranslationOutput` and called it "the exact transform the
  production pipeline applies" — but the product streams, through
  `StreamAssembler`, which never touched it. Replayed through the real path,
  the reported 0% preamble and 0% echo were actually **8.7% and 8.7%**. Both
  leaks traced to one cause: the reluctant buffer's 12 characters is shorter
  than the artifacts it exists to catch, so `Here is the translation: …`
  flushed at `Here is the` and the rest streamed to the panel. The buffer is
  now adaptive and every harness replays the shipped assembler. A convenient
  function is how an eval starts lying about the thing it is meant to prove.

## How it works

- **Reliability layer** ([`src/core/sanitize.ts`](../src/core/sanitize.ts)) —
  anchored preamble/thinking filters, echo removal, quote unwrapping.
- **Streaming assembler** ([`src/core/stream.ts`](../src/core/stream.ts)) — a
  "reluctant buffer" holds only the opening tokens (where preamble hides) so the
  translation still paints fast, then streams the rest straight through. The
  hold is _adaptive_: it extends only while something is actually resolving — a
  preamble that has not reached its colon, an unclosed `<think>` block, an echo
  of the selection still arriving — and is capped so first paint cannot stall.
  Measured on real qwen3 output, clean translations are held for exactly as
  many characters as before; only artifact-shaped openings wait longer.
- **Taiwan localization** ([`src/core/zh-convert.ts`](../src/core/zh-convert.ts)) —
  OpenCC `s2twp` phrase-level Simplified→Traditional conversion, replacing v1's
  hand-rolled character map that corrupted `界面→界麵` and `公里→公裡`. Because
  it maps _phrases_, converting each stream chunk on its own mistranslates any
  phrase a chunk boundary splits (`数据` + `库` → `數據庫`, not `資料庫`), so the
  transform holds the ambiguous tail back until enough context arrives — the
  streamed result is byte-identical to converting the finished text in one call.
- **Why there is no `OLLAMA_ORIGINS` step**
  ([`src/core/dnr-rule.ts`](../src/core/dnr-rule.ts)) — Ollama answers a request
  whose `Origin` it does not recognise with a 403, and a browser extension's
  origin is never on its default list. Measured against a stock server: no
  `Origin` header → 200, `Origin: chrome-extension://…` → 403. The header _is_
  the wall, so OpenRead strips it with one `declarativeNetRequest` session
  rule and the setup step stops existing. Until 2.5.0 the answer to this was a
  well-written error message, which is not the same as a fix.

  The scoping is the interesting part, because `Origin` is exactly what stops
  a web page from driving a local model it has no business touching. The rule
  matches only `tabIds: [-1]` — requests with no owning tab, which means this
  extension's own — and only a URL anchored to the configured server. A
  request from a page always carries a real tab id, never matches, and keeps
  facing Ollama's check unchanged.

- **Verified in a browser, not only in jsdom**
  ([`e2e/fullpage.mjs`](../e2e/fullpage.mjs)) — every unit test here runs in
  jsdom, which cannot tell you whether an extension loads, whether a content
  script is injected, or whether the service worker is awake when a message
  arrives. Three shipped defects (2.2.11–2.2.13) were invisible until the built
  extension was loaded into Chrome. `pnpm e2e:page` does that loading over CDP,
  drives the real popup message against a live page and a real local model, and
  asserts the properties that matter: translations land, the original survives,
  chrome under the length floor is skipped, and toggling again restores the
  page byte for byte. It is deliberately not in CI — GitHub's runners have no
  GPU and no model, and a translation harness that stubs the model is measuring
  the stub.
- **Whole-page translation as a queue, not a flood**
  ([`src/ui/fullpage.ts`](../src/ui/fullpage.ts) +
  [`src/ui/blocks.ts`](../src/ui/blocks.ts)) — Ollama serves one generation per
  model, so firing fifty parallel requests only builds a queue in arrival
  order, which is not the order anyone reads in. Two requests stay in flight
  and the page fills top-down. Block selection takes the leaf-most prose
  element (a `li` wrapping a `p` is translated once, not twice), reads text
  through a walk that skips `<style>` and `<script>` children rather than
  `textContent` (one Wikipedia reference item was 2,158 characters of which
  2,100 were a stylesheet, and the model dutifully translated `no-repeat` as
  `無重複`), leaves reference lists and `<cite>` alone because a bibliography is
  a lookup key rather than prose, drops blocks that are only an address (the one cell that failed on every run of a real
  article was `github.com/ollama/ollama` — letters, nothing to translate),
  scopes to the
  page's `main`/`article` landmark when it declares one, drops navigational
  chrome, refuses to descend into `code`/`pre`, honours `translate="no"` and
  `.notranslate`, and skips anything already in the target language through the
  same `shouldBypassAI` short-circuit selection uses. Measured on real pages:
  Wikipedia's article for Ollama goes from **325 candidate blocks to 48**, and
  the first block translated changes from "Current events" to the opening
  sentence. Translations are _appended_,
  never substituted: a local 8B model is good, not perfect, and a reader has
  to be able to check a sentence that looks wrong.

  ![Whole-page bilingual translation on the Wikipedia article for Ollama: each paragraph's Traditional-Chinese translation under the original, navigation and table of contents untouched](screenshots/demo-fullpage.png)

- **Keyboard-first, not keyboard-afterthought** — text selected with
  Shift+Arrow or Ctrl+A offers the 文 button just as a mouse selection does, the
  button takes Enter/Space, Escape dismisses the panel, and
  **`Ctrl+Shift+Y`** translates the selection without touching the icon at all.
  The panel is a named `role="dialog"` whose content is an `aria-live` region,
  so a streamed translation is actually announced.
- **Same-language short-circuit**
  ([`src/core/language.ts`](../src/core/language.ts)) — script detection skips the
  API entirely when a selection is already in the target language (zero latency,
  zero cost). The Simplified/Traditional marker sets are _derived from the
  OpenCC dictionaries_ (`pnpm gen:markers`), not hand-written: the hand-written
  lists both flagged shared characters like 系 and 游 as Simplified and missed
  common ones like 发 and 时.
- **Cancellation-safe streaming**
  ([`src/api/ollama.ts`](../src/api/ollama.ts) +
  [`src/entrypoints/background.ts`](../src/entrypoints/background.ts)) — each
  request owns an `AbortController`; a new selection or a closed panel aborts
  the in-flight stream with no shared mutable state to race on.
- **Reasoning-model safe** — the client uses Ollama's native `/api/chat` with
  `think: false` because the benchmark caught the OpenAI-compat endpoint
  burning entire generations as hidden reasoning with zero visible output on
  qwen3-family and deepseek-r1 models
  ([`docs/BENCHMARK.md`](BENCHMARK.md) §6). Requires Ollama ≥ 0.9.

See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the module map and the
streaming sequence diagram.

## The enrichment stage, and its honest negative result

Optionally, a small local model can pre-label a capture with a title, summary,
and tags. That pipeline is defense-in-depth, and every layer is _measured_:

| Layer                                         | Evidence                                                                                                                                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema-constrained decoding (Ollama `format`) | took the one imperfect model (deepseek-r1) from 93.3% → **100%** usable metadata at zero latency cost — live study over 4 models × 16 excerpts ([`eval/STRUCTURED-RESULTS.md`](../eval/STRUCTURED-RESULTS.md))                               |
| Tolerant `parseEnrichResponse`                | salvages 71.4% vs naive parsing's 42.9% on an archive of 14 hostile reply shapes from older/thinking models ([`eval/CAPTURE-RESULTS.md`](../eval/CAPTURE-RESULTS.md)); today it mostly does content hygiene — length caps, tag normalisation |
| `status: raw` handoff                         | even a perfect-looking label is garnish; the raw capture stays the source of truth                                                                                                                                                           |

The live study also produced an honest negative result: with the shipped
prompt, temperature 0, and thinking disabled, **modern small models emit
clean JSON ~100% of the time** — the dramatic salvage rates belong to older
model generations. Enrichment stays off by default anyway: it adds a
model round-trip per capture, and reasoning-class models take ~45 s to label
a paragraph (measured), which no capture UX survives.

## Bugs this rebuild fixed

v1 was ~1,500 lines of untyped JavaScript. Each of these was found by rebuilding
it, and each is why a corresponding test exists:

1. `viewer_init.js` loaded `pdf.worker.js`; the file is `pdf.worker.mjs`. The
   PDF worker never started.
2. `utils/zh-map.js` advertised "~2,800 pairs"; the string was ~200 characters
   repeated four or five times.
3. Unconditional `面→麵`, `里→裡`, `台→臺` substitution corrupted `界面→界麵`
   and `公里→公裡`. OpenCC replaced it.
4. The manifest declared `scripting` and `declarativeNetRequest` and used
   neither — a store-review red flag, and permissions a privacy-first extension
   has no business asking for.
5. `content.js` and `pdf-integration.js` were ~90% copy-paste of each other.
   They are now one module.
