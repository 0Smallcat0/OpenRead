# Architecture

OpenRead is split into a **pure, framework-free core** (all the interesting
logic, fully unit-tested) and thin **extension shells** (WXT entrypoints) that
wire the core to Chrome APIs and the network.

## Module map

```
src/
  core/                 pure, dependency-free, unit-tested — the technical core
    language.ts           script detection + same-language short-circuit
    sanitize.ts           preamble / thinking / echo / quote stripping
    stream.ts             StreamAssembler — reluctant-buffer streaming logic
    zh-convert.ts         OpenCC s2twp Simplified→Traditional wrapper
    prompt.ts             system prompt + adaptive anti-echo few-shot
    capture.ts            capture → Markdown + obsidian:// URI builders
    enrich.ts             enrich prompt + tolerant small-model JSON salvager
    types.ts              shared domain types
  api/
    ollama.ts             typed streaming + single-shot + enrich client
  messaging.ts            typed content⇄background port + one-shot protocol
  settings.ts             typed chrome.storage.sync wrapper
  ui/
    selection.ts          shared selection icon + panel + stream client
    capture.ts            capture orchestrator: enrich round-trip + write
  entrypoints/
    background.ts         service worker: stream broker + PDF router + enrich
    content.ts            mounts the selection translator on web pages
    pdf-viewer.ts         mounts the same translator inside the PDF.js viewer
    popup/                settings UI (index.html + main.ts)
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
            B->>B: StreamAssembler.push (buffer opening,<br/>strip preamble, SC→TC)
            B-->>C: {status:"streaming", chunk}
            C-->>U: append chunk to panel
        end
        O-->>B: {done:true, eval_count}
        B-->>C: {status:"done"}
    end

    Note over U,B: A new selection or closed panel<br/>disconnects the port → controller.abort()
```

## Key design decisions

| Decision                                                                        | Rationale                                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Per-request `AbortController`, no shared global                                 | v1 used a module-global controller that raced across concurrent selections; per-request signals cannot race.              |
| Reluctant buffer in `StreamAssembler`                                           | Preamble/thinking appears in the first tokens. Buffering only the opening lets us strip it while still painting fast.     |
| OpenCC `s2twp` over a hand-rolled map                                           | v1's unconditional character map corrupted common words (`界面→界麵`). Phrase-level conversion is correct and maintained. |
| Ollama base URL read in background from storage; request goes to a local server | No secret rides the message bus — and since the request never leaves the machine, there's nothing to leak either way.     |
| Offline, deterministic eval                                                     | Before/after numbers are reproducible in CI without a running Ollama server, so they are honest to cite.                  |
| Native `/api/chat` + `think: false`, not the OpenAI-compat `/v1`                | On reasoning models `/v1` can burn the whole generation as hidden `reasoning` with `content` empty — the user sees nothing. Found by the benchmark; see `docs/BENCHMARK.md` §6. |
| Live benchmark imports the shipped modules                                      | `pnpm bench` scores `buildMessages`/`extractChunk`/`StreamAssembler` themselves, so its numbers describe the product, not a re-implementation. |
| Capture writes via `obsidian://new` from the content script, not a new API      | Keeps least-privilege intact (no `downloads`/native-host permission) and reuses the user gesture; oversized notes fall back to the clipboard. |
| Captures are `status: raw`; heavy synthesis deferred to a downstream model      | On-device small models fail at structured output (measured), so OpenRead ships a reliable raw note and lets a stronger "second brain" process it. |
