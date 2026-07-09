# OpenRead — Reliability Eval Results

Offline, deterministic run over **23** curated fixtures (21 Traditional-Chinese targets). No network, no Ollama server needed.

| Metric | Applicable | Before | After | Reduction |
| --- | --- | --- | --- | --- |
| Preamble / thinking leakage | 23 | 8 (34.8%) | 0 (0.0%) | 100% |
| Input echo | 23 | 4 (17.4%) | 0 (0.0%) | 100% |
| Simplified leakage (TC targets) | 21 | 8 (38.1%) | 0 (0.0%) | 100% |

_Before = raw model output. After = output passed through the pure reliability layer (`cleanTranslationOutput` + OpenCC `s2twp`)._

