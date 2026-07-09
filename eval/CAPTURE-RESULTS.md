# OpenRead — Capture Enrichment Eval

Offline, deterministic run over **14** small-model reply fixtures. No network, no Ollama server needed.

| Metric | Count | Rate |
| --- | --- | --- |
| Naive `JSON.parse` yields an object | 6 | 42.9% |
| Robust `parseEnrichResponse` yields usable metadata | 10 | 71.4% |
| Usable title recovered | 9 | 64.3% |
| Usable summary recovered | 9 | 64.3% |
| ≥1 tag recovered | 9 | 64.3% |

_The robust parser recovers usable metadata from **5** replies that a naive `JSON.parse` drops (fenced, preamble-wrapped, or trailing-prose output), while rejecting empty/garbage replies that naive parsing would wave through. Enrichment is best-effort — every capture writes a raw note regardless._

