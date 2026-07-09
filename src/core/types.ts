/** Shared domain types for the pure translation core. */

/** A single message in an OpenAI-compatible chat completion request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Optional surrounding text used to disambiguate a translation. The model is
 * instructed to translate only `target`, using the neighbours for context.
 */
export interface TranslationContext {
  contextBefore?: string;
  contextAfter?: string;
}
