# Contributing to OpenRead

Thanks for your interest in contributing. This document covers everything you need to get set up and send a clean pull request.

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io/installation)

## Setup

```sh
pnpm install
```

## Development

Run the extension in dev mode with hot reload:

```sh
pnpm dev           # Chrome
pnpm dev:firefox   # Firefox
```

## Quality gates

Run these before pushing — CI runs the same checks:

```sh
pnpm compile   # tsc --noEmit
pnpm test      # vitest run
pnpm lint      # eslint .
pnpm build     # wxt build
```

## Loading the unpacked extension

1. Build the extension: `pnpm build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `.output/chrome-mv3`

## Running the eval

The translation reliability harness runs offline against a fixed dataset:

```sh
pnpm eval
```

The live evaluation suite — `pnpm bench` (model × prompt benchmark),
`pnpm eval:structured` (structured-output study), `pnpm bench:agreement`
(judge↔human calibration), and the older `eval/judge.ts` — calls real models
instead of fixed datasets. It needs a local [Ollama](https://ollama.com/)
server (≥ 0.9) — install Ollama, then `ollama pull qwen3` — and reads the
server URL from the `OLLAMA_URL` env var (default `http://localhost:11434`);
no API key required. See [`docs/BENCHMARK.md`](docs/BENCHMARK.md) for the
methodology.

After changing anything in the streaming pipeline, re-score the recorded
generations instead of re-running the models — same model output, so the
pipeline's effect is isolated from sampling noise:

```sh
pnpm bench -- --repipe
```

The Simplified/Traditional marker sets in `src/core/zh-markers.generated.ts`
are derived from the OpenCC dictionaries, not hand-written. Regenerate them
after an `opencc-js` bump; a test fails if the committed file has drifted:

```sh
pnpm gen:markers
```

## Manual UI harness

jsdom computes no geometry, so the unit tests can prove the selection UI's
control flow and none of the things that only exist once a rendering engine is
involved. `pnpm harness` mounts the UI on a plain Vite page with `chrome`
stubbed and the translation faked, for checking layout, focus and
`prefers-color-scheme` by hand:

```sh
pnpm harness
```

It is not the extension — the keyboard shortcut and the content-script wiring
still need `pnpm build` plus a real unpacked load.

## Project layout

- `src/core` — pure, tested translation/reliability logic (no browser APIs)
- `src/api` — Ollama client
- `src/ui` — shared selection UI used by both web and PDF
- `src/entrypoints` — background worker, content script, popup, PDF viewer
- `eval/` — offline reliability eval harness and dataset
- `scripts/` — code generators (script markers)
- `harness/` — manual browser harness for the selection UI (`pnpm harness`)
- `tests/` — the one test that cannot sit beside its module: WXT treats every
  file under `src/entrypoints/` as an entrypoint, so `background.test.ts` there
  would collide with `background.ts`
- `public/pdfjs` — vendored PDF.js viewer

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — a new feature
- `fix:` — a bug fix
- `docs:` — documentation only changes
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or correcting tests
- `chore:` — tooling, dependencies, or other maintenance
