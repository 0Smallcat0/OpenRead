# OpenRead — Translation Benchmark

Live model × prompt matrix over **27** curated EN→zh-TW fixtures (216 generations recorded). Generations run through the exact shipped pipeline (`buildMessages` → native `/api/chat` NDJSON, `think: false` → `extractChunk` → `StreamAssembler` + OpenCC). Decoding: temperature 0.3, seed 42. Judge: `qwen3.5:latest` (native `/api/chat`, JSON-schema constrained, temperature 0). Regenerate with `pnpm bench`.

## Quality — corpus chrF against references

| Model | Prompt | chrF raw | chrF shipped pipeline | Δ pipeline |
| --- | --- | --- | --- | --- |
| qwen3.5:latest | naive | 44.1 | 44.7 | 0.6 |
| qwen3.5:latest | engineered | 42.9 | 43.4 | 0.4 |
| qwen3:latest | naive | 44.2 | 44.4 | 0.1 |
| qwen3:latest | engineered | 45.9 | 46.3 | 0.5 |
| llama3.1:latest | naive | 32.5 | 32.1 | -0.3 |
| llama3.1:latest | engineered | 32.1 | 31.6 | -0.5 |
| deepseek-r1:8b | naive | 32.8 | 35.2 | 2.4 |
| deepseek-r1:8b | engineered | 36.4 | 36.6 | 0.1 |

## Streaming artifacts — raw vs shipped pipeline

| Model | Prompt | Preamble raw→piped | Echo raw→piped | Simplified raw→piped |
| --- | --- | --- | --- | --- |
| qwen3.5:latest | naive | 0.0% → 0.0% | 0.0% → 0.0% | 7.4% → 7.4% |
| qwen3.5:latest | engineered | 0.0% → 0.0% | 0.0% → 0.0% | 7.4% → 7.4% |
| qwen3:latest | naive | 0.0% → 0.0% | 0.0% → 0.0% | 7.4% → 7.4% |
| qwen3:latest | engineered | 0.0% → 0.0% | 0.0% → 0.0% | 11.1% → 7.4% |
| llama3.1:latest | naive | 7.4% → 0.0% | 0.0% → 0.0% | 7.4% → 3.7% |
| llama3.1:latest | engineered | 0.0% → 0.0% | 0.0% → 0.0% | 7.4% → 3.7% |
| deepseek-r1:8b | naive | 0.0% → 0.0% | 0.0% → 0.0% | 18.5% → 7.4% |
| deepseek-r1:8b | engineered | 0.0% → 0.0% | 0.0% → 0.0% | 11.1% → 11.1% |

## Latency

_TTFT-net = first SSE content token; TTFT-UI = first text the panel paints (after the reluctant buffer). The gap is the price of preamble filtering; for reasoning models the wait is dominated by hidden thinking._

| Model | Prompt | TTFT-net p50 (ms) | TTFT-UI p50 (ms) | Tokens/s | Errors |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:latest | naive | 554 | 766 | 13.7 | 0/27 |
| qwen3.5:latest | engineered | 545 | 730 | 42.4 | 0/27 |
| qwen3:latest | naive | 258 | 453 | 47.8 | 0/27 |
| qwen3:latest | engineered | 255 | 451 | 48.0 | 0/27 |
| llama3.1:latest | naive | 301 | 534 | 48.6 | 0/27 |
| llama3.1:latest | engineered | 299 | 532 | 49.1 | 0/27 |
| deepseek-r1:8b | naive | 6568 | 6568 | 457.0 | 0/27 |
| deepseek-r1:8b | engineered | 6353 | 6353 | 477.0 | 0/27 |

## LLM-judge quality (1–5)

_Judged end-to-end experiences: `naive` = raw baseline output, `engineered` = shipped pipeline output. Reference-based grading; see `docs/BENCHMARK.md` for judge calibration against human labels._

| Model | Prompt | Adequacy | Fluency | TW localization | Judged |
| --- | --- | --- | --- | --- | --- |
| qwen3.5:latest | naive | 4.74 | 4.89 | 4.78 | 27/27 |
| qwen3.5:latest | engineered | 4.67 | 4.93 | 4.78 | 27/27 |
| qwen3:latest | naive | 4.70 | 4.78 | 4.33 | 27/27 |
| qwen3:latest | engineered | 4.48 | 4.70 | 4.37 | 27/27 |
| llama3.1:latest | naive | 4.44 | 4.70 | 4.37 | 27/27 |
| llama3.1:latest | engineered | 4.30 | 4.63 | 4.41 | 27/27 |
| deepseek-r1:8b | naive | 4.41 | 4.81 | 4.22 | 27/27 |
| deepseek-r1:8b | engineered | 4.19 | 4.85 | 4.41 | 27/27 |

_Hardware: local Ollama (http://localhost:11434). Latency numbers are machine-specific; relative comparisons are the point._

