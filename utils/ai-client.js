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
        return `Role: Professional Academic Translator. Target: Traditional Chinese (Taiwan).\nRules:\n1. Accurate, Fluent, Academic tone.\n2. Use strict Taiwan IT/Finance terms (e.g. 電腦, 程式, 演算法).\n3. Translate DIRECTLY. NO "Here is".`;
    }

    // Generic
    return `Role: Professional Translator. Target: ${targetLang}.\nRules:\n1. Translate DIRECTLY.\n2. Natural and fluent phrasing.`;
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

// Global variable to track the active request for race condition handling
let currentController = null;

export async function translateStream(text, apiKey, model, targetLang, contextObj, onChunk, retryCount = 0) {
    if (!text) return;
    if (!apiKey) throw new Error("API Key is missing");

    // [MOCK MODE] Logic for testing
    if (apiKey.toLowerCase().startsWith("mock-") || apiKey.startsWith("sk-test")) {
        // ... (Mock logic)
    }

    // 1. CANCEL PREVIOUS REQUEST
    if (currentController) {
        // This stops the previous fetch and its stream reader immediately
        currentController.abort();
        // console.log("[OIT] Aborted previous stream.");
    }

    // 2. Create new controller for the current request
    currentController = new AbortController();
    const signal = currentController.signal;

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
            signal: signal, // <--- BIND SIGNAL HERE
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

        // --- FAST STREAM PIPELINE ---
        let contentBuffer = "";
        let isBuffering = true; // Only buffer the very start to catch "Sure," or "Here is"
        const isTargetTC = targetLang === 'Traditional Chinese' || targetLang === 'Traditional Chinese (Taiwan)' || targetLang.includes('繁體');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data: ")) {
                    const dataStr = trimmed.slice(6);
                    if (dataStr === "[DONE]") continue;

                    try {
                        const json = JSON.parse(dataStr);
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) {
                            if (isBuffering) {
                                contentBuffer += delta;
                                // Reluctant Buffer: Fast but Safe (12 chars or newline)
                                if (contentBuffer.length > 12 || contentBuffer.includes('\n')) {
                                    // Flush
                                    let clean = contentBuffer;
                                    // Simple prefix check
                                    if (isAIThinking(clean)) {
                                        clean = cleanAIArtifacts(clean, true);
                                    }

                                    if (isTargetTC) clean = convertSCToTC(clean);
                                    if (clean) onChunk(clean);

                                    isBuffering = false;
                                    contentBuffer = "";
                                }
                            } else {
                                // Direct Stream
                                let chunk = delta;
                                if (isTargetTC) chunk = convertSCToTC(chunk);
                                onChunk(chunk);
                            }
                        }
                    } catch (e) {
                        console.warn("Stream Parse Error:", e);
                    }
                }
            }
        }

        // Flush remaining if any
        if (isBuffering && contentBuffer.length > 0) {
            let clean = contentBuffer;
            if (isAIThinking(clean)) clean = cleanAIArtifacts(clean, true);
            if (isTargetTC) clean = convertSCToTC(clean);
            if (clean) onChunk(clean);
        }

    } catch (error) {
        // 3. SILENT EXIT FOR ABORT
        if (error.name === 'AbortError') {
            // console.log("[OIT] Request cancelled by user action.");
            return; // Do NOT call onError, just stop.
        }
        console.error("Streaming Translation failed:", error);
        throw error;
    } finally {
        // Cleanup: If this request finished naturally, clear the controller
        if (currentController && currentController.signal === signal) {
            currentController = null;
        }
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
    // Ordered by length (longest first) to avoid partial matching issues
    const terms = [
        ['计算机', '電腦'],
        ['服务器', '伺服器'],
        ['互联网', '網際網路'],
        ['数据库', '資料庫'],
        ['各种', '各種'], // Fix common generic
        ['通过', '透過'], // Fix common generic
        ['为了', '為了'], // Fix common generic

        // IT / Tech
        ['软件', '軟體'],
        ['硬件', '硬體'],
        ['程序', '程式'],
        ['算法', '演算法'],
        ['默认', '預設'],
        ['接口', '介面'],
        ['模块', '模組'],
        ['变量', '變數'],
        ['函数', '函式'],
        ['数组', '陣列'],
        ['对象', '物件'],
        ['内存', '記憶體'],
        ['硬盘', '硬碟'],
        ['视频', '影片'],
        ['音频', '音訊'],
        ['屏幕', '螢幕'],
        ['鼠标', '滑鼠'],
        ['键盘', '鍵盤'],
        ['网络', '網路'],
        ['链接', '連結'],
        ['在线', '線上'],
        ['离线', '離線'],
        ['支持', '支援'],
        ['搜索', '搜尋'],
        ['用户', '使用者'],
        ['项目', '專案'],
        ['文件', '檔案'], // Context dependent
        ['信息', '資訊'], // or 訊息
        ['质量', '品質'],
        ['优化', '最佳化'],
        ['智能', '智慧'],
        ['移动', '行動'],
        ['数码', '數位'],
        ['博客', '部落格'],
        ['优盘', '隨身碟'],
        ['士巴拿', '扳手'],
        ['交互', '互動'],
        ['运作', '運作'],
        ['发送', '傳送'],
        ['打印', '列印']
    ];

    let result = text;
    for (const [sim, tra] of terms) {
        // Global replace using split/join is fast enough for ~50 terms
        // For larger lists, we'd use a regex, but this is fine.
        while (result.includes(sim)) {
            result = result.replace(sim, tra);
        }
    }

    // 2. Character Mapping (Full Database)
    return convertSCToTC(result);
}

// REMOVED mapSCToTCChars - We use zh-map.js now for 2800+ chars coverage

