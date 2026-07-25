/** Shared domain types for the pure translation core. */

/** A single message in an OpenAI-compatible chat completion request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A stateful transform applied to a stream of text chunks.
 *
 * Stateful because some conversions read more than one character at a time —
 * phrase-level Simplified->Traditional, for one — and so cannot treat a chunk
 * in isolation: a phrase split across two chunks would convert wrongly. Such a
 * transform holds the ambiguous tail back and gives it up on `end()`.
 */
export interface ChunkTransform {
  /** Transform what is safe to emit now; '' while text is still held back. */
  push(chunk: string): string;
  /** Flush anything still held. Called once, when the stream closes. */
  end(): string;
}

/**
 * Optional surrounding text used to disambiguate a translation. The model is
 * instructed to translate only `target`, using the neighbours for context.
 */
export interface TranslationContext {
  contextBefore?: string;
  contextAfter?: string;
}

/**
 * A single reading capture — the raw unit OpenRead hands off to an external
 * knowledge base (e.g. an Obsidian vault). Deliberately unprocessed: heavy
 * synthesis is deferred to a stronger downstream model, so `status` starts at
 * 'raw' and the frontmatter is a stable contract, not a finished note.
 */
export interface CaptureNote {
  /** Note title — an enrichment title when available, else the page title. */
  title: string;
  /** Originating document title (`document.title`). */
  source: string;
  /** Canonical page URL (PDF viewer URLs are unwrapped to the real file). */
  url: string;
  /** ISO 8601 capture timestamp. */
  capturedAt: string;
  /** Source language, or 'auto' when undetected. */
  from: string;
  /** Target language the translation is in. */
  to: string;
  /** The text the user selected, verbatim. */
  original: string;
  /** The streamed translation of `original`. */
  translation: string;
  /** One-sentence summary from optional local enrichment. */
  summary?: string;
  /** Tags for downstream querying; always includes 'openread'. */
  tags: string[];
  /** Handoff flag: 'raw' until a downstream system processes the note. */
  status: 'raw' | 'processed';
}

/**
 * Structured metadata a small local model may produce for a capture. Every
 * field is optional because weak models fail partially — the parser keeps
 * whatever is usable and the capture proceeds regardless.
 */
export interface EnrichResult {
  title?: string;
  summary?: string;
  tags?: string[];
}
