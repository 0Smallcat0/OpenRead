/**
 * Prompt construction — the system prompt and adaptive few-shot examples that
 * steer the model toward "translation only, no chatter".
 *
 * Kept pure and separate from the network client so the exact prompt for any
 * target language can be asserted in tests and diffed in the eval harness.
 */
import type { ChatMessage } from './types';

function isTraditionalChinese(targetLang: string): boolean {
  return (
    targetLang.includes('Traditional') ||
    targetLang.includes('繁體') ||
    targetLang.includes('Taiwan')
  );
}

function isSimplifiedChinese(targetLang: string): boolean {
  return targetLang.includes('Simplified') || targetLang.includes('简体');
}

/**
 * Build the system prompt for a target language. English and Traditional
 * Chinese (Taiwan) get specialised instructions; everything else uses a generic
 * "translate directly, stay fluent" template. Every variant forbids preamble.
 */
export function generateSystemPrompt(targetLang: string): string {
  if (targetLang.toLowerCase().includes('english')) {
    return [
      'Target: English.',
      'Rules:',
      '1. Output ONLY the translation.',
      '2. Maintain the original meaning.',
      '3. Do not output anything else.',
    ].join('\n');
  }

  if (isTraditionalChinese(targetLang)) {
    return [
      'Role: Professional Academic Translator. Target: Traditional Chinese (Taiwan).',
      'Rules:',
      '1. Accurate, fluent, academic tone.',
      '2. Use strict Taiwan IT/finance terms (e.g. 電腦, 程式, 演算法).',
      '3. Translate DIRECTLY. No "Here is", no preamble.',
    ].join('\n');
  }

  return [
    `Role: Professional Translator. Target: ${targetLang}.`,
    'Rules:',
    '1. Translate DIRECTLY.',
    '2. Natural and fluent phrasing.',
    '3. Output only the translation.',
  ].join('\n');
}

/**
 * Adaptive few-shot examples. For Chinese targets we prime two behaviours: a
 * direct translation, and a no-echo response (input and output differ), which
 * is the single most effective guard against the "model repeats the source"
 * failure. Other targets rely on the system prompt alone to keep latency low.
 */
export function getFewShotMessages(targetLang: string): ChatMessage[] {
  const isChinese =
    targetLang.includes('Chinese') || targetLang.includes('中文');
  if (!isChinese) return [];

  const simplified = isSimplifiedChinese(targetLang);
  return [
    { role: 'user', content: 'What is the capital of France?' },
    {
      role: 'assistant',
      content: simplified ? '法国的首都是哪里？' : '法國的首都是哪裡？',
    },
    { role: 'user', content: 'Hello world' },
    { role: 'assistant', content: '你好世界' },
  ];
}
