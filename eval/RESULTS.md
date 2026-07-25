# OpenRead — Reliability Eval Results

Offline, deterministic run over **23** curated fixtures (21 Traditional-Chinese targets). No network, no Ollama server needed.

| Metric                          | Applicable | Before    | After    | Reduction |
| ------------------------------- | ---------- | --------- | -------- | --------- |
| Preamble / thinking leakage     | 23         | 8 (34.8%) | 0 (0.0%) | 100%      |
| Input echo                      | 23         | 4 (17.4%) | 0 (0.0%) | 100%      |
| Simplified leakage (TC targets) | 21         | 9 (42.9%) | 0 (0.0%) | 100%      |

_Before = raw model output. After = the same output replayed through the **shipped streaming pipeline** — `StreamAssembler` (reluctant buffer, preamble and echo removal) plus the OpenCC `s2twp` transform — in 3-character deltas, so chunk boundaries fall mid-artifact exactly as they do in a live stream._
