# Architecture

OpenRead is split into a **pure, framework-free core** (all the interesting
logic, fully unit-tested) and thin **extension shells** (WXT entrypoints) that
wire the core to Chrome APIs and the network.

## Module map

```
src/
  core/                 pure, dependency-free, unit-tested — the technical core
    language.ts           script detection + same-language short-circuit
    zh-markers.generated.ts  SC-only / TC-only character sets (pnpm gen:markers)
    sanitize.ts           preamble / thinking / echo / quote stripping
    stream.ts             StreamAssembler — reluctant-buffer streaming logic
    zh-convert.ts         OpenCC s2twp conversion + phrase-safe streaming transform
    prompt.ts             system prompt + adaptive anti-echo few-shot
    tw-vocab.ts           mainland → Taiwan word choices, for Traditional targets
    bcp47.ts              language name → the tag Chrome's translator takes
    auto-translate.ts     whether a page translates itself, and per-site exceptions
    glossary.ts           terms held out of translation behind a placeholder
    capture.ts            capture → Markdown + obsidian:// URI builders
    enrich.ts             enrich prompt + tolerant small-model JSON salvager
    diagnostics.ts        connection probe verdicts + engine-failure wording
    dnr-rule.ts           the Origin-strip rule, so Ollama needs no OLLAMA_ORIGINS
    types.ts              shared domain types
  api/
    builtin.ts            Chrome's on-device translator: pairs, packs, retry
    ollama.ts             typed streaming + single-shot + enrich client
    probe.ts              is the server there, and does it have that model
  messaging.ts            typed content⇄background port + one-shot protocol
  settings.ts             typed chrome.storage.sync wrapper
  ui/
    selection.ts          shared selection icon + panel + stream client
    fullpage.ts           the live queue: viewport first, then follow the reader
    blocks.ts             what counts as a translatable block, and what is ours
    hover.ts              hold a key, point at one paragraph
    input-translate.ts    replace what you typed, keeping the undo stack
    pdf-blocks.ts         lines → paragraphs, by line pitch and column overlap
    pdf-translate.ts      a whole PDF, each page's translation under that page
    port-translate.ts     one block through the background port
    popup.ts              the settings UI's logic, testable without a popup
    capture.ts            capture orchestrator: enrich round-trip + write
  entrypoints/
    background.ts         service worker: stream broker + PDF router + enrich
    content.ts            mounts the selection translator on web pages
    pdf-viewer.ts         mounts the same translator inside the PDF.js viewer
    popup/                settings UI (index.html + main.ts)
scripts/
  gen-zh-markers.ts       derives the script-marker sets from the OpenCC dictionaries
tests/
  background.test.ts      the one test that cannot sit beside its module: WXT
                          treats every file under src/entrypoints/ as an entrypoint
public/
  pdfjs/                  vendored PDF.js viewer (worker path fixed to .mjs)
eval/
  dataset/fixtures.json         curated translation failure-mode fixtures
  dataset/capture-fixtures.json curated small-model enrichment reply shapes
  dataset/bench-fixtures.json   27 EN→zh-TW segments with Taiwan-convention references
  dataset/enrich-inputs.json    16 realistic capture excerpts (EN/zh-TW/mixed)
  detectors.ts                  preamble / Simplified / echo detectors (reuse core)
  run.ts                        offline before→after runner → eval/RESULTS.md (CI gate)
  capture-run.ts                offline enrichment-parser runner → eval/CAPTURE-RESULTS.md
  bench/                        live model × prompt benchmark (needs Ollama, not CI)
    chrf.ts                       chrF metric, sacrebleu-cross-validated
    kappa.ts                      Cohen's κ (plain + quadratic-weighted)
    run.ts                        matrix runner + LLM judge → eval/BENCHMARK-RESULTS.md
    agreement.ts                  human-labeling page + judge↔human κ → eval/AGREEMENT.md
  structured/                   live structured-output study (needs Ollama, not CI)
    taxonomy.ts                   failure-shape classifier for small-model replies
    run.ts                        prompt vs schema-constrained → eval/STRUCTURED-RESULTS.md
```

### Why this split

- **The core has no `chrome.*`, no `fetch`, no DOM.** That is what makes it
  100%-unit-testable and what lets the eval harness measure the _shipped_ logic
  by importing the exact same functions.
- **The web content script and the PDF viewer script share one module**
  (`ui/selection.ts`). v1 duplicated ~90% of the selection UI between
  `content.js` and `pdf-integration.js`; v2 has a single source of truth.
- **The Ollama base URL never leaves the background worker.** Content scripts
  send only `{ text, targetLang, model }`; the broker reads the base URL from
  `chrome.storage` itself, so it never rides the message bus.

## Streaming flow

A selection triggers a long-lived port to the background worker, which owns the
network call and streams cleaned chunks back. Each request has its own
`AbortController`, so a new selection (or a closed panel) cancels the previous
stream cleanly.

The client talks to Ollama's **native `/api/chat`** endpoint (NDJSON streaming)
with `think: false`. The benchmark found that the OpenAI-compat `/v1` endpoint
routes reasoning-model chain-of-thought into a separate field and can leave
`content` empty for the entire generation (qwen3.5: 99 s, 4,055 tokens, zero
visible output) — the native endpoint disables thinking on hybrid models and
keeps it out of `content` on models that cannot stop (deepseek-r1). Requires
Ollama ≥ 0.9. See [`BENCHMARK.md`](BENCHMARK.md) §6.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Content script (ui/selection.ts)
    participant B as Background broker
    participant O as Ollama (local, /api/chat NDJSON)

    U->>C: select text, click 文
    C->>C: shouldBypassAI(text, target)?
    alt already in target language
        C-->>U: render source verbatim (0 network)
    else needs translation
        C->>B: connect "stream-translate" + START_STREAM {text, target, model}
        B->>B: load Ollama base URL from storage; new AbortController
        B->>O: POST /api/chat (stream:true, think:false, signal)
        loop each NDJSON chunk
            O-->>B: {message:{content}, done:false}
            B->>B: StreamAssembler.push (hold while an artifact<br/>resolves, strip preamble/echo, SC→TC)
            B-->>C: {status:"streaming", chunk}
            C-->>U: append chunk to panel
        end
        O-->>B: {done:true, eval_count}
        B-->>C: {status:"done"}
    end

    Note over U,B: A new selection or closed panel<br/>disconnects the port → controller.abort()
```

## Key design decisions

| Decision                                                                        | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-request `AbortController`, no shared global                                 | v1 used a module-global controller that raced across concurrent selections; per-request signals cannot race.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reluctant buffer in `StreamAssembler`                                           | Preamble/thinking appears in the first tokens. Buffering only the opening lets us strip it while still painting fast.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The hold is adaptive, not a fixed 12 characters                                 | 12 characters is shorter than the artifacts the buffer exists to catch: `Here is the translation: …` flushed at `Here is the`, so the cleaner never saw the colon and `translation: …` reached the panel. The hold now extends only while a preamble, a `<think>` block or an echo is still resolving, and is capped at 400 characters. Clean output is held for exactly as many characters as before.                                                                                                                                                                                                                                                                                                     |
| The offline eval replays through `StreamAssembler`, not a whole-output cleaner  | It used to score `cleanTranslationOutput`, which no shipped path called — so it credited echo removal the streaming path could not perform. Scoring the convenient function instead of the shipped one is how an eval starts lying.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| OpenCC `s2twp` over a hand-rolled map                                           | v1's unconditional character map corrupted common words (`界面→界麵`). Phrase-level conversion is correct and maintained.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Streaming conversion holds back an ambiguous tail (`TraditionalTWTransform`)    | `s2twp` maps phrases, so converting each chunk alone mistranslates any phrase a chunk boundary splits (`数据`+`库`→`數據庫`, not `資料庫`). Measured on 216 recorded generations: 13.0% converted differently from a whole-text call; 0.0% after.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Script markers derived from the dictionaries, not hand-written                  | The hand-written lists failed both ways: shared forms (系, 游) were flagged as Simplified, so correct output scored as leakage and `shouldBypassAI` translated Traditional selections needlessly; and common Simplified characters (发, 时, 们, 开, 软, 机) were missing, so `计算机软件开发` was not detected at all. `pnpm gen:markers` derives both sets from OpenCC; a test fails on drift.                                                                                                                                                                                                                                                                                                            |
| Ollama base URL read in background from storage; request goes to a local server | No secret rides the message bus — and since the request never leaves the machine, there's nothing to leak either way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Offline, deterministic eval                                                     | Before/after numbers are reproducible in CI without a running Ollama server, so they are honest to cite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Native `/api/chat` + `think: false`, not the OpenAI-compat `/v1`                | On reasoning models `/v1` can burn the whole generation as hidden `reasoning` with `content` empty — the user sees nothing. Found by the benchmark; see `docs/BENCHMARK.md` §6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `think: false` leaks a control token into the prompt — measured, not filtered   | Ollama's qwen3 template appends ` /no_think` to the **last user message** whenever a request sets `think: false`. The extension sends no translation context, so that message is the bare source text and the token is glued onto the sentence being translated. Seen once in real use, rendered as content: `…且位於 /no_think 路徑下`. Not filtered, on the evidence: 0 leaks in 216 recorded and 278 fresh generations swept over temperature and selection length. Fencing the source in `<target>` tags was measured too — chrF 46.39 vs the shipped prompt's 46.76, no gain, so it was not shipped. `hasControlTokenLeak` reports the rate in `pnpm bench` so the decision can be revisited on data. |
| Live benchmark imports the shipped modules                                      | `pnpm bench` scores `buildMessages`/`extractChunk`/`StreamAssembler` themselves, so its numbers describe the product, not a re-implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Capture writes via `obsidian://new` from the content script, not a new API      | Keeps least-privilege intact (no `downloads`/native-host permission) and reuses the user gesture; oversized notes fall back to the clipboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Captures are `status: raw`; heavy synthesis deferred to a downstream model      | On-device small models fail at structured output (measured), so OpenRead ships a reliable raw note and lets a stronger "second brain" process it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
