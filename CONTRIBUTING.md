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

The optional live LLM-as-judge (`eval/judge.ts`) calls a real model instead of
the fixed dataset. It needs a local [Ollama](https://ollama.com/) server —
install Ollama, then `ollama pull qwen2.5` — and reads the server URL from the
`OLLAMA_URL` env var (default `http://localhost:11434`); no API key required.

## Project layout

- `src/core` — pure, tested translation/reliability logic (no browser APIs)
- `src/api` — Ollama client
- `src/ui` — shared selection UI used by both web and PDF
- `src/entrypoints` — background worker, content script, popup, PDF viewer
- `eval/` — offline reliability eval harness and dataset
- `public/pdfjs` — vendored PDF.js viewer

## Commit style

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — a new feature
- `fix:` — a bug fix
- `docs:` — documentation only changes
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or correcting tests
- `chore:` — tooling, dependencies, or other maintenance
