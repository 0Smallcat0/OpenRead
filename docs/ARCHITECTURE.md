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
    types.ts              shared domain types
  api/
    ollama.ts             typed streaming + single-shot client, pure extractDelta
  messaging.ts            typed content⇄background port + one-shot protocol
  settings.ts             typed chrome.storage.sync wrapper
  ui/
    selection.ts          shared selection icon + panel + stream client
  entrypoints/
    background.ts         service worker: stream broker + PDF router
    content.ts            mounts the selection translator on web pages
    pdf-viewer.ts         mounts the same translator inside the PDF.js viewer
    popup/                settings UI (index.html + main.ts)
public/
  pdfjs/                  vendored PDF.js viewer (worker path fixed to .mjs)
eval/
  dataset/fixtures.json   curated failure-mode fixtures
  detectors.ts            preamble / Simplified / echo detectors (reuse core)
  run.ts                  before→after runner → eval/RESULTS.md
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
SSE cleanly.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Content script (ui/selection.ts)
    participant B as Background broker
    participant O as Ollama (local, SSE)

    U->>C: select text, click 文
    C->>C: shouldBypassAI(text, target)?
    alt already in target language
        C-->>U: render source verbatim (0 network)
    else needs translation
        C->>B: connect "stream-translate" + START_STREAM {text, target, model}
        B->>B: load Ollama base URL from storage; new AbortController
        B->>O: POST /chat/completions (stream:true, signal)
        loop each SSE delta
            O-->>B: data: {delta.content}
            B->>B: StreamAssembler.push (buffer opening,<br/>strip preamble, SC→TC)
            B-->>C: {status:"streaming", chunk}
            C-->>U: append chunk to panel
        end
        O-->>B: data: [DONE]
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
