import { translateText } from './ai-client.js';

/**
 * Orchestrates the translation of a subtitles array.
 * @param {Array<{start: string, duration: string, text: string}>} subtitles 
 * @param {string} apiKey 
 * @param {string} model 
 * @param {string} targetLang 
 * @returns {Promise<Array<{start: string, duration: string, original: string, translated: string}>>}
 */
export async function translateSubtitles(subtitles, apiKey, model, targetLang) {
    if (!subtitles || subtitles.length === 0) return [];

    // 1. Extract texts
    const allTexts = subtitles.map(s => s.text);

    // 2. Batching
    // YouTube captions can be long. We must split them to avoid token limits.
    // A safe batch size for JSON arrays might be 20-50 lines depending on length.
    // Let's go with 30 lines handling roughly 1-2 minutes of video.
    const BATCH_SIZE = 30;
    const batches = [];
    for (let i = 0; i < allTexts.length; i += BATCH_SIZE) {
        batches.push(allTexts.slice(i, i + BATCH_SIZE));
    }

    // console.log(`[Translator] Translating ${subtitles.length} lines in ${batches.length} batches.`);

    let translatedTexts = [];

    // 3. Process batches sequentially (or parallel with limit, but let's be safe safely first)
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        // console.log(`[Translator] Processing batch ${i + 1}/${batches.length}...`);

        try {
            const translatedBatch = await translateBatch(batch, apiKey, model, targetLang);
            translatedTexts = translatedTexts.concat(translatedBatch);
        } catch (error) {
            console.error(`[Translator] Batch ${i + 1} failed:`, error);
            // Fallback: fill with empty strings or original text to keep alignment?
            // "Trust the User" -> If I cannot verify, I request instruction or fail.
            // But here I must be robust. I will fill with error markers to maintain array length.
            const fallback = new Array(batch.length).fill("[Translation Failed]");
            translatedTexts = translatedTexts.concat(fallback);
        }
    }

    // 4. Merge back
    return mergeSubtitles(subtitles, translatedTexts);
}

/**
 * Translates a single batch of strings ensuring 1:1 mapping.
 * @param {string[]} textArray 
 * @param {string} apiKey 
 * @param {string} model 
 * @param {string} targetLang 
 */
async function translateBatch(textArray, apiKey, model, targetLang) {
    // Construct the input for the AI
    // We send a JSON array string.
    const inputJson = JSON.stringify(textArray);

    const systemPrompt = `
You are a professional subtitle translator.
Translate the following JSON array of strings into ${targetLang}.
Strictly follow these rules:
1. Translate strictly line-by-line.
2. The output MUST be a valid JSON array of strings.
3. The number of elements in the output array MUST match exactly the input array (${textArray.length} items).
4. Do not merge or split lines.
5. Do not include any explanations or markdown formatting (like \`\`\`json). Just the raw JSON array.
`.trim();

    try {
        const rawResponse = await translateText(inputJson, apiKey, model, targetLang, { systemPrompt });

        // Sanitize response if it includes markdown code blocks (common LLM behavior)
        let cleanedResponse = rawResponse.trim();
        if (cleanedResponse.startsWith('```json')) {
            cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleanedResponse.startsWith('```')) {
            cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        const parsed = JSON.parse(cleanedResponse);

        if (!Array.isArray(parsed)) {
            throw new Error("Response is not an array");
        }
        if (parsed.length !== textArray.length) {
            console.warn(`[Translator] Mismatch length! Input: ${textArray.length}, Output: ${parsed.length}`);
            // Attempt to reconcile or just return as much as we have?
            // Safer to throw or pad? Parsing mismatch is critical for subtitles.
            // Let's pad or truncate to match.
            while (parsed.length < textArray.length) parsed.push("");
            if (parsed.length > textArray.length) parsed.length = textArray.length;
        }

        return parsed;

    } catch (e) {
        console.error("[Translator] JSON parsing or translation error:", e);
        throw e;
    }
}

/**
 * Merges original subtitles with translated text.
 * @param {Array} originalSubtitles 
 * @param {Array} translatedTexts 
 */
function mergeSubtitles(originalSubtitles, translatedTexts) {
    // Safety check
    const length = Math.min(originalSubtitles.length, translatedTexts.length);

    return originalSubtitles.slice(0, length).map((item, index) => ({
        ...item,
        original: item.text,
        translated: translatedTexts[index]
    }));
}
