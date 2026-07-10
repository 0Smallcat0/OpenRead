# OpenRead — Structured-Output Study

Small-model enrichment replies over **16** realistic capture excerpts × **4** local models, generated once per condition (temperature 0, seed 42) and scored offline. `prompt` = the shipped prompt-rules-only path; `schema` = decoding constrained to the EnrichResult JSON schema. Regenerate with `pnpm eval:structured`.

## Headline — usable metadata rate by strategy

| Generation | Parse | Usable rate | All 3 fields |
| --- | --- | --- | --- |
| prompt | naive `JSON.parse` | 100.0% | — |
| prompt | robust `parseEnrichResponse` | 100.0% | 98.4% |
| schema | naive `JSON.parse` | 100.0% | — |
| schema | robust `parseEnrichResponse` | 100.0% | 100.0% |

## Per model

| Model | Gen | Naive parse | Robust parse | All fields | Median ms | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:latest | prompt | 100.0% | 100.0% | 100.0% | 1838 | 0/16 |
| qwen3.5:latest | schema | 100.0% | 100.0% | 100.0% | 1845 | 0/16 |
| qwen3:latest | prompt | 100.0% | 100.0% | 100.0% | 1665 | 0/16 |
| qwen3:latest | schema | 100.0% | 100.0% | 100.0% | 1729 | 0/16 |
| llama3.1:latest | prompt | 100.0% | 100.0% | 100.0% | 1126 | 0/16 |
| llama3.1:latest | schema | 100.0% | 100.0% | 100.0% | 1109 | 0/16 |
| deepseek-r1:8b | prompt | 100.0% | 100.0% | 93.3% | 46300 | 1/16 |
| deepseek-r1:8b | schema | 100.0% | 100.0% | 100.0% | 45309 | 0/16 |

## Failure shapes — unconstrained (`prompt`) replies

| Model | clean-json | fenced-json | thinking-then-json | json-with-prose | truncated-json | no-json | empty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:latest | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| qwen3:latest | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| llama3.1:latest | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| deepseek-r1:8b | 15 | 0 | 0 | 0 | 0 | 0 | 0 |

_Both conditions run on the native `/api/chat` endpoint with `think: false` (the shipped client path); `schema` adds the `format` parameter. Latency medians include any hidden reasoning time._

