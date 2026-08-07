# OpenRead — built-in engine quality

Chrome's on-device translator — the extension's **default engine** — over the same **27** EN→zh-TW fixtures, the same references and the same chrF implementation `pnpm bench` uses, so these numbers sit directly beside the model table in [BENCHMARK-RESULTS.md](BENCHMARK-RESULTS.md). Regenerate with `pnpm eval:builtin`.

_Recorded in a real Chrome with the built extension loaded. **shipped** is driven through the extension's own `stream-translate` port — the broker the content script talks to — so it is the text a reader is actually shown. **raw** is `Translator.translate()` called directly in the same browser and the same session, which is what Chrome returns before this extension touches it. The source language is declared rather than detected, so a detector miss cannot move a translation score._

## Quality — corpus chrF against references

| Condition         | chrF | vs raw |
| ----------------- | ---- | ------ |
| Chrome, raw       | 36.4 | —      |
| OpenRead, shipped | 36.5 | +0.1   |

For scale: the best cell in [BENCHMARK-RESULTS.md](BENCHMARK-RESULTS.md) — `qwen3:latest`, engineered prompt, shipped pipeline — scores **46.4** on these same segments. So the engine that costs nothing to install is about ten chrF behind the one that costs a server and five gigabytes. Against that, a whole segment finishes here in 20 ms (p50, through the extension) while that model's _first character_ arrives at 451 ms. That is the trade the default engine is making, in numbers, for the first time.

### By domain

_Where the engine is weak, rather than how weak it is on average. `tricky` is idiom, units and mixed code; `coll` is colloquial._

| Domain     | Segments | chrF |
| ---------- | -------- | ---- |
| news       | 4        | 36.4 |
| tech-docs  | 5        | 42.6 |
| academic   | 4        | 41.5 |
| ui-strings | 4        | 35.5 |
| colloquial | 4        | 36.5 |
| tricky     | 6        | 31.6 |

## The Taiwan vocabulary pass

Segments it rewrote: **1/27** (3.7%), worth +0.1 corpus chrF. Segments where the shipped output differs from applying `toTaiwanVocabulary` to the raw output here: **0** — anything but zero would mean the shipped pipeline is not the pure function it is documented as.

That is far below what `core/tw-vocab.ts` was built on: 32 substitutions in a single translated article, counted by hand. Both are true. The article was software documentation, where 本地, 運行, 代碼 and 用戶 are on every screen; this fixture set is mostly news, academic abstracts, interface copy and colloquial speech, and its 5 technical segments are the only place the table has anything to catch. The finding is about the fixture set as much as about the pass — the corpus this project scores translation quality on barely covers the domain its one quality layer exists for.

| Fixture | Δ chrF | Chrome wrote                                               | OpenRead shows                                             |
| ------- | ------ | ---------------------------------------------------------- | ---------------------------------------------------------- |
| tech-03 | +3.0   | 當所有待處理的寫入都已刷新到磁碟時，此函數會傳回一個解析。 | 當所有待處理的寫入都已刷新到磁碟時，此函式會傳回一個解析。 |

## Artifacts

_The detectors `pnpm eval` runs on the Ollama path, pointed at this one. A statistical translator has no chat behaviour to strip, so zero across the board is the expected reading — the value of running them is that "expected" is not "measured"._

| Detector           | raw  | shipped |
| ------------------ | ---- | ------- |
| Preamble           | 0.0% | 0.0%    |
| Echo of the source | 0.0% | 0.0%    |
| Simplified leak    | 0.0% | 0.0%    |

## Latency

_Per segment, with the language pack already downloaded. **Through the extension** carries a round trip to the service worker on top of the translation itself. The pack download is a once-per-pair cost, paid before the first timed call and excluded here — mistaking it for a per-use cost is what sent an earlier performance investigation down the wrong road._

| Path                  | p50 (ms) | mean (ms) |
| --------------------- | -------- | --------- |
| Translator.translate  | 22       | 23        |
| Through the extension | 20       | 29        |

## Per fixture

_Worst first, which is the useful order for a quality report._

| Fixture   | chrF | Shown to the reader                                                                                                                                                                                                                                        |
| --------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tricky-01 | 9.3  | 這不是火箭科學——在開始之前閱讀手冊。                                                                                                                                                                                                                       |
| ui-04     | 12.1 | 在此處拖放文件，或點擊瀏覽。                                                                                                                                                                                                                               |
| tricky-04 | 14.1 | 台北地鐵每天運送超過 200 萬名乘客，票價取決於行駛距離。                                                                                                                                                                                                    |
| news-01   | 16.3 | 央行週四將利率提高了四分之一點，理由是持續通膨和勞動力市場緊張。                                                                                                                                                                                           |
| coll-04   | 20.7 | 我不敢相信他真的成功了——每個人都認為最後期限是不可能的。                                                                                                                                                                                                   |
| tricky-06 | 21.7 | 今晚打斷一條腿！ 你已經排練了一百次，所以相信自己，享受舞台。                                                                                                                                                                                              |
| ui-01     | 24.4 | 你的連線已經過期 請再次登入以繼續。                                                                                                                                                                                                                        |
| coll-02   | 25.7 | 抱歉回覆晚了！ 這週工作很瘋狂。                                                                                                                                                                                                                            |
| news-04   | 26.1 | 週六早些時候，談判者達成了臨時協議，但雙方警告，有幾個關鍵問題仍未解決。                                                                                                                                                                                   |
| coll-03   | 26.7 | 那家餐廳完全值得等待，但要早點去，否則你會永遠排隊。                                                                                                                                                                                                       |
| tricky-05 | 27.6 | 大型語言模型一次產生一個令牌，這意味著使用者介面接收小片段流，而不是完整的答案。 串流 UI 必須決定何時顯示每個片段：顯示令牌會立即感覺響應，但有暴露工件的風險，而緩衝整個回應會以漫長的空白等待為代價隱藏人工製品。 大多數生產系統都決定了兩者之間的妥協。 |
| acad-03   | 30.8 | 參與者被隨機分配到三個條件之一，實驗是雙盲的。                                                                                                                                                                                                             |
| tech-05   | 31.5 | 預設情況下，伺服器會偵聽連接埠 8080； 設定連接埠環境變數以覆蓋此行為。                                                                                                                                                                                     |
| tech-02   | 36.0 | 如果請求在逾時失敗，客戶端會以指數退縮重試，最多可嘗試五次。                                                                                                                                                                                               |
| tech-03   | 36.7 | 當所有待處理的寫入都已刷新到磁碟時，此函式會傳回一個解析。                                                                                                                                                                                                 |
| ui-03     | 39.3 | 已儲存的設定。 重新啟動應用程式以使更改生效。                                                                                                                                                                                                              |
| acad-01   | 40.2 | 我們提出了一種新穎的注意力機制，可將記憶體消耗減少 40%，同時保持下游任務的準確性。                                                                                                                                                                         |
| acad-04   | 42.4 | 這些發現應謹慎解釋，因為樣本量很小，並且來自單一機構。                                                                                                                                                                                                     |
| news-03   | 46.7 | 該公司今年第二次下調年度收入預測後，股價下跌近 8%。                                                                                                                                                                                                        |
| tricky-02 | 46.8 | 新晶片的速度提高了 3.2 倍，在負載下消耗 15 瓦，售價為 249 美元。                                                                                                                                                                                           |
| tech-04   | 51.3 | 已棄用：改用異步變體。 此方法阻止主執行緒，並將在下一個主要版本中刪除。                                                                                                                                                                                    |
| acad-02   | 52.8 | 結果顯示，觀察到的相關性主要是由混雜變數而不是因果關係所驅動。                                                                                                                                                                                             |
| news-02   | 56.3 | 野火迫使數千名居民在一夜之間撤離沿海城鎮，官員警告強風可能會將火焰蔓延到更遠的內陸。                                                                                                                                                                       |
| tech-01   | 58.3 | 快取將頻繁存取的資料儲存在記憶體中，減少到資料庫的往返次數。                                                                                                                                                                                               |
| tricky-03 | 59.7 | 首先執行 `npm install`，然後在您的 .env 檔案中設定 `debug=true` 以啟用詳細記錄。                                                                                                                                                                           |
| ui-02     | 59.7 | 你確定要刪除這個檔案嗎？ 這個動作無法撤銷。                                                                                                                                                                                                                |
| coll-01   | 66.9 | 老實說，這部電影並沒有大家說的那麼糟——我可能會再看一次。                                                                                                                                                                                                   |

## What this does not say

- **27 segments, one language pair, one Chrome.** Chrome ships a separate model per pair, so nothing here transfers to en→ja or ja→zh. A number for those is another run of this file away, and has not been run.
- **chrF against one reference is a proxy.** Each fixture has a single Taiwanese translation, and a different-but-correct rendering scores lower than a mediocre one that happens to share characters with it. The per-fixture table is there so the reader can check the metric against the text rather than take it.
- **The worst scores here are idioms, not vocabulary.** "It's not rocket science" comes back as 這不是火箭科學 and "break a leg" as 打斷一條腿. No word-substitution table reaches those, and the eval exists partly to stop a table being extended in the hope that it might.
- **Nothing here was tuned on these fixtures.** The vocabulary table predates this run. Adding entries picked by reading these outputs would raise this score and measure nothing, which is the failure mode this file was written to replace.
