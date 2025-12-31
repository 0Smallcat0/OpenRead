import { convertSCToTC } from './zh-map.js';

/**

 * Call OpenRouter API to translate a batch of texts.
 * @param {string[]} textArray - Array of strings to translate.
 * @param {string} apiKey - OpenRouter API Key.
 * @param {string} model - The model to use.
 * @param {string} targetLang - Target language.
 * @returns {Promise<string[]>} Array of translated strings.
 */

// ===========================================
// HELPER: Output Sanitizer (The Safety Net)
// ===========================================

// [OIT Patch] Aggressive Thinking Filter
function cleanAIArtifacts(text, isStart = false) {
    // 1. Define patterns of "AI Monologue"
    const noisePatterns = [
        /^The user wants/i,
        /^The user is asking/i,
        /^Let me (analyze|translate|break down)/i,
        /^Here is the translation/i,
        /^Sure, I can help/i,
        /^Translation:/i,
        /^好的，使用者/i,
        /^這段文字是關於/i,
        /^我會將其翻譯/i,
        /^讓我逐句/i,
        /^Analysis:/i,
        /^Step 1:/i,
        /^I will/i
    ];

    let clean = text;

    // 2. Initial Chunk Filtering (Aggressive)
    if (isStart) {
        for (let pattern of noisePatterns) {
            if (pattern.test(clean)) {

                // Attempt to find the first double newline which often separates thought from result
                const splitMatch = clean.split(/\n\n/);
                if (splitMatch.length > 1) {
                    // Return everything AFTER the first double newline
                    clean = splitMatch.slice(1).join('\n\n').trim();
                } else {
                    // If no clear separation, try to strip the specific matched line or prefix
                    clean = clean.replace(pattern, "").trim();
                    // Also generic "Translation:" cleanup just in case pattern misses
                    clean = clean.replace(/^(Translation|Answer|Output|Result|Here is the translation)[:\s-]*/i, "").trim();
                }
            }
        }
    }

    // 3. Constant Cleanup (All Chunks)

    // Remove Input Echo (if output starts with input)

    // Remove Quotes if the model wrapped the output in quotes (start/end check)
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1);
    }

    return clean;
}

function cleanTranslationOutput(input, output) {
    let clean = cleanAIArtifacts(output.trim(), true);

    // 3. Remove Input Echo (if output starts with input)
    if (input && clean.toLowerCase().startsWith(input.trim().toLowerCase())) {
        clean = clean.substring(input.length).trim();
    }

    return clean;
}

// ===========================================
// HELPER: Adaptive Few-Shot Examples (Fixing the Context)
// ===========================================
function getFewShotMessages(targetLang, userInput) {
    let examples = [];

    // Adaptive Examples based on Target Language
    if (targetLang.includes('Chinese') || targetLang.includes('中文')) {
        const isSimplified = targetLang.includes('Simplified') || targetLang.includes('简体');
        examples = [
            { role: "user", content: "What is the capital of France?" },
            { role: "assistant", content: isSimplified ? "法国的首都是哪里？" : "法國的首都是哪裡？" }, // Direct Translation
            { role: "user", content: "Hello world" },
            { role: "assistant", content: isSimplified ? "你好世界" : "你好世界" } // No Echo
        ];
    } else if (targetLang.toLowerCase().includes('english')) {
        // Speed Opt: Remove few-shots for English to rely on system prompt.
        examples = [];
    } else {
        // Generic Fallback (Abstract)
        examples = [];
    }

    return examples;
}

// ===========================================
// HELPER: Dynamic System Prompt Engine
// ===========================================
function generateSystemPrompt(targetLang) {
    // 1. Detect Mode
    const isTC = targetLang === 'Traditional Chinese' || targetLang === 'Traditional Chinese (Taiwan)' || targetLang.includes('Traditional');
    const isEnglish = targetLang.toLowerCase().includes('english');

    if (isEnglish) {
        return `Target: English.\nRules:\n1. Output ONLY the translation.\n2. Maintain original meaning.\n3. Do not output anything else.`;
    }

    if (isTC) {
        return `You are a specialized translation engine, NOT a chatbot.
Your SOLE function is to convert input text into Traditional Chinese (Taiwan).

### IMPORTANT INSTRUCTION:
If you must analyze the text, enclose your thoughts in <think> tags.
Example:
<think>The user wants me to translate...</think>
[Actual Translation Here]

### RULES (VIOLATION = FAILURE):
1. **NO PREAMBLE:** Do not say "Here is the translation", "Let me analyze", or "The user wants".
2. **NO REASONING:** Do not output your thought process unless inside <think> tags.
3. **NO EXPLANATIONS:** Do not explain why you chose a word.
4. **DIRECT OUTPUT:** Start the output with the translated text immediately.
5. **GAME TERMS:** Use standard Taiwanese gaming terminology for game-related texts.

### EXAMPLES (Follow this format EXACTLY):

Input:
"Hello world. This is a test."

Output:
你好世界。這是一個測試。

Input:
"Fate of the Vaal Rewards Get a Big Buff"

Output:
瓦爾獎勵獲得大幅增強

### TARGET LANGUAGE:
Traditional Chinese (Taiwan) / 繁體中文 (台灣)`;
    }

    // Generic
    return `Target: ${targetLang}.\nRules:\n1. Output ONLY the translation.\n2. Ensure natural phrasing.\n3. Do not output reasoning.`;
}

/**
 * Call OpenRouter API to translate text with STREAMING.
 * @param {string} text - The input text (or JSON object if context aware).
 * @param {string} apiKey 
 * @param {string} model 
 * @param {string} targetLang 
 * @param {object} contextObj - Optional { contextBefore, contextAfter }
 * @param {function} onChunk - Callback for each chunk of text
 * @param {number} retryCount - 0 for first try, 1+ for retries
 */

// [OIT Patch] Smart Stream Filter
// Helper function to detect if text looks like AI "thinking"
function isAIThinking(text) {
    const noisePatterns = [
        /^<think>/i,
        /^好的/i,
        /^Sure/i,
        /^Here is/i,
        /^Let me/i,
        /^The user/i,
        /^Translation/i,
        /^這段文字/i,
        /^我會/i,
        /^我將/i,
        /^首先/i,
        /^analysis/i,
        /^Step 1:/i,
        /^Answer:/i
    ];
    return noisePatterns.some(pattern => pattern.test(text.trim()));
}

export async function translateStream(text, apiKey, model, targetLang, contextObj, onChunk, retryCount = 0) {
    if (!text) return;
    if (!apiKey) throw new Error("API Key is missing");

    // [MOCK MODE] Logic for testing
    if (apiKey.toLowerCase().startsWith("mock-") || apiKey.startsWith("sk-test")) {
        // ... (Mock logic)
    }

    // Construct Prompt
    let systemPrompt = generateSystemPrompt(targetLang);
    let userContent = text;

    if (contextObj) {
        userContent = `<context_before>\n${contextObj.contextBefore || ""}\n</context_before>\n` +
            `<target>\n${text}\n</target>\n` +
            `<context_after>\n${contextObj.contextAfter || ""}\n</context_after>\n` +
            `Instruction: Translate only the text inside <target>.`;
    }

    // Get Adaptive Few-Shot Examples
    const fewShots = getFewShotMessages(targetLang, text);

    // Construct Messages
    const messages = [
        { role: "system", content: systemPrompt },
        ...fewShots,
        { role: "user", content: userContent }
    ];

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/immersive-translate/open-immersive-translate",
                "X-Title": "Open Immersive Translate"
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: retryCount > 0 ? 0.7 : 0.3, // Low temp for precision
                stream: true // ENABLE STREAMING
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API Error ${response.status}: ${errorData.error?.message || JSON.stringify(errorData)}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = ""; // Line buffer for streaming parser

        // --- HYBRID PIPELINE STATE ---
        let contentBuffer = "";  // Accumulates text for filter checking
        let isBuffering = true;  // [OIT] Strict Buffering State
        const isTargetTC = targetLang === 'Traditional Chinese' || targetLang === 'Traditional Chinese (Taiwan)' || targetLang.includes('繁體');
        // -----------------------------

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process buffer line by line
            const lines = buffer.split("\n");
            buffer = lines.pop(); // Keep the last partial line in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data: ")) {
                    const dataStr = trimmed.slice(6);
                    if (dataStr === "[DONE]") continue;

                    try {
                        const json = JSON.parse(dataStr);
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) {

                            // [OIT] Strict Buffering & Anti-Hallucination Logic
                            if (isBuffering) {
                                contentBuffer += delta;

                                // 1. Check for Separator (Strong Signal)
                                const separatorIndex = contentBuffer.indexOf('\n\n');
                                if (separatorIndex !== -1) {
                                    // CASE A: Separator found!
                                    // Check if the part BEFORE the separator looks like noise
                                    const preText = contentBuffer.substring(0, separatorIndex);

                                    if (isAIThinking(preText)) {
                                        // It IS noise! Discard it.
                                        let realText = contentBuffer.substring(separatorIndex + 2); // Skip the \n\n
                                        if (isTargetTC) realText = convertSCToTC(realText);
                                        onChunk(realText);
                                    } else {
                                        // It was NOT noise (just a normal paragraph). Send everything.
                                        let fullBuf = contentBuffer;
                                        if (isTargetTC) fullBuf = convertSCToTC(fullBuf);
                                        onChunk(fullBuf);
                                    }
                                    isBuffering = false;
                                    contentBuffer = "";
                                }
                                // 2. Check for Clean Start (Fast Path)
                                // If buffer is substantial (>50 chars) and doesn't trigger "Thinking" pattern
                                else if (contentBuffer.length > 50 && !isAIThinking(contentBuffer)) {
                                    // CASE B: It's clean from the start!
                                    let fullBuf = contentBuffer;
                                    if (isTargetTC) fullBuf = convertSCToTC(fullBuf);
                                    onChunk(fullBuf);
                                    isBuffering = false;
                                    contentBuffer = "";
                                }
                                // CASE C: Still looks like thinking or too short, keep buffering...

                            } else {
                                // Not buffering? Just stream it directly!
                                let processedChunk = delta;
                                if (isTargetTC) {
                                    processedChunk = convertSCToTC(processedChunk);
                                }
                                onChunk(processedChunk);
                            }
                        }
                    } catch (e) {
                        console.warn("Stream Parse Error:", e);
                    }
                }
            }
        }

        // Flush remaining buffer if stream ends while still buffering
        if (isBuffering && contentBuffer.length > 0) {
            // Final check: if it looks like AI thinking till the very end, we might want to drop it?
            if (isAIThinking(contentBuffer)) {
                // Try to strip prefix?
                // If it ends with just noise, output nothing.
            } else {
                let clean = contentBuffer;
                if (isTargetTC) clean = convertSCToTC(clean);
                onChunk(clean);
            }
        }

    } catch (error) {
        console.error("Streaming Translation failed:", error);
        throw error;
    }
}


/**
 * Call OpenRouter API to translate a batch of texts.
 * ... (Legacy Batch Mode for future use or batch operations) ...
 */
export async function translateBatch(textArray, apiKey, model, targetLang) {
    if (!textArray || textArray.length === 0) return [];
    if (!apiKey) throw new Error("API Key is missing");

    // [MOCK MODE] Logic for testing
    if (apiKey.toLowerCase().startsWith("mock-")) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return textArray.map(t => `[Mock] ${t}`);
    }

    // Dynamic Prompt
    const systemPrompt = generateSystemPrompt(targetLang);

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(textArray) }
    ];

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/immersive-translate/open-immersive-translate",
                "X-Title": "Open Immersive Translate"
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: 0.3, // Low temperature for consistency
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API Error ${response.status}: ${errorData.error?.message || JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        let content = data.choices?.[0]?.message?.content;

        if (!content) throw new Error("Empty response from AI");

        // Parse & Clean
        let parsed;
        try {
            content = content.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
            parsed = JSON.parse(content);
        } catch (e) {
            console.warn("[AI Client] JSON Parse Failed. Trying fallback...", e);
            throw new Error("Failed to parse AI response as JSON");
        }

        if (!Array.isArray(parsed)) throw new Error("AI returned non-array JSON");

        // Apply cleaning to each item
        parsed = parsed.map(text => {
            if (typeof text !== 'string') return text;
            return cleanTranslationOutput(null, text); // Context input is unknown in batch for now
        });

        // NUCLEAR FIX: Enforce Traditional Chinese ONLY if target is TC
        if (targetLang.includes('Traditional Chinese') || targetLang.includes('繁體')) {
            parsed = parsed.map(text => simplifiedToTraditional(text));
        }

        return parsed;

    } catch (error) {
        console.error("Batch Translation failed:", error);
        throw error;
    }
}

/**
 * Call OpenRouter API to translate text (SINGLE ITEM).
 * Used for sequential retry fallbacks.
 */
export async function translateText(text, apiKey, model, targetLang, options = {}) {
    if (!text) return "";
    if (!apiKey) throw new Error("API Key is missing");

    // [MOCK MODE] Logic for testing
    if (apiKey.toLowerCase().startsWith("mock-")) {
        await new Promise(resolve => setTimeout(resolve, 600));
        return `[Mock] ${text}`;
    }

    const systemPrompt = options.systemPrompt || generateSystemPrompt(targetLang);
    const fewShots = getFewShotMessages(targetLang, text);

    const messages = [
        { role: "system", content: systemPrompt },
        ...fewShots,
        { role: "user", content: text }
    ];

    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/immersive-translate/open-immersive-translate",
                "X-Title": "Open Immersive Translate"
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`API Error ${response.status}: ${errorData.error?.message || JSON.stringify(errorData)}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("Empty response");

        // Apply Cleaning
        let cleaned = cleanTranslationOutput(text, content);

        // NUCLEAR FIX: Enforce Traditional Chinese ONLY if target is TC
        if (targetLang && (targetLang.includes('Traditional Chinese') || targetLang.includes('繁體'))) {
            cleaned = simplifiedToTraditional(cleaned);
        }

        return cleaned;

    } catch (error) {
        console.error("Single Translation failed:", error);
        throw error;
    }
}

/**
 * Client-Side Simplified to Traditional Converter ("The Nuclear Fix")
 * Mappings for common simplified characters and terminology.
 */
function simplifiedToTraditional(text) {
    if (!text) return text;

    // 1. Terminology Replacement (Mainland -> Taiwan)
    // We do this first to catch multi-char terms
    const terms = [
        ['视频', '影片'],
        ['软件', '軟體'],
        ['信息', '資訊'],
        ['硬盘', '硬碟'],
        ['程序', '程式'],
        ['网络', '網路'],
        ['优盘', '隨身碟'],
        ['博客', '部落格'],
        ['鼠标', '滑鼠'],
        ['屏幕', '螢幕'],
        ['默认', '預設'],
        ['链接', '連結'],
        ['项目', '專案'], // Context dependent, but usually Project -> 專案 in tech
        ['服务器', '伺服器'],
        ['云端', '雲端'],
        ['士巴拿', '扳手'],
        ['智能', '智慧'] // Added AI context
    ];

    let result = text;
    for (const [sim, tra] of terms) {
        // Global replace
        result = result.split(sim).join(tra);
    }

    // 2. Character Mapping (Common subset)
    return mapSCToTCChars(result);
}

/**
 * 1:1 Character Mapping Helper (Safe for Streams)
 */
function mapSCToTCChars(text) {
    if (!text) return text;
    const charMap = {
        '爱': '愛', '关': '關', '国': '國', '开': '開', '门': '門', '见': '見',
        '体': '體', '爷': '爺', '贫': '貧', '贝': '貝', '车': '車', '东': '東',
        '马': '馬', '长': '長', '乱': '亂', '儿': '兒', '几': '幾', '电': '電',
        '头': '頭', '么': '麼', '为': '為', '来': '來', '两': '兩', '还': '還',
        '动': '動', '这': '這', '点': '點', '个': '個', '样': '樣', '总': '總',
        '办': '辦', '书': '書', '听': '聽', '说': '說', '远': '遠', '发': '發',
        '变': '變', '实': '實', '专': '專', '师': '師', '导': '導', '复': '復',
        '记': '記', '业': '業', '义': '義', '备': '備', '医': '醫', '笔': '筆'
    };
    return text.split('').map(char => charMap[char] || char).join('');
}
