/**
 * Streaming assembly logic, extracted from the network client so it can be
 * unit-tested without a live SSE connection.
 *
 * The problem: a model's very first tokens are where preamble ("Sure, here
 * is...") and visible thinking appear, but we also want to start painting the
 * translation on screen as fast as possible. The compromise is a *reluctant
 * buffer*: hold only the first few characters, just long enough to decide
 * whether they are noise, then stream everything after that straight through.
 */
import { isAIThinking, cleanAIArtifacts, stripEcho } from './sanitize';
import type { ChunkTransform } from './types';

/** No-op transform used when the caller supplies none. */
const PASS_THROUGH: ChunkTransform = {
  push: (chunk) => chunk,
  end: () => '',
};

export interface StreamAssemblerOptions {
  /**
   * Applied to the emitted text — e.g. Simplified->Traditional conversion.
   * Stateful, so a transform can hold back a chunk boundary that would split a
   * phrase; `end()` flushes whatever it kept. Defaults to a pass-through.
   */
  transform?: ChunkTransform;
  /**
   * Flush the initial buffer once it exceeds this many characters (or contains
   * a newline) — provided nothing suspicious is still forming. Larger = safer
   * preamble detection but slower first paint.
   */
  bufferThreshold?: number;
  /**
   * The selected text. Supplying it enables echo removal: some models restate
   * the source before translating it, and the echo can only be recognised
   * against the thing being echoed.
   */
  source?: string;
  /**
   * Hard cap on the opening buffer, so a model that opens with something
   * artifact-shaped and never resolves it cannot stall the first paint.
   */
  maxBuffer?: number;
}

/**
 * Feed raw model deltas in with `push()`; get back cleaned text to render (or
 * an empty string while still buffering). Call `end()` when the stream closes
 * to flush a buffer that never reached the threshold.
 */
export class StreamAssembler {
  private buffering = true;
  private buffer = '';
  private readonly transform: ChunkTransform;
  private readonly threshold: number;
  private readonly source: string;
  private readonly maxBuffer: number;
  /** Set when the flush dropped an echo, so the gap it left is not painted. */
  private trimNext = false;

  constructor(options: StreamAssemblerOptions = {}) {
    this.transform = options.transform ?? PASS_THROUGH;
    this.threshold = options.bufferThreshold ?? 12;
    this.source = options.source?.trim() ?? '';
    this.maxBuffer = options.maxBuffer ?? 400;
  }

  /**
   * Is the opening still ambiguous enough to be worth holding?
   *
   * The plain threshold is what makes the buffer *reluctant* rather than
   * merely small, but 12 characters is shorter than the artifacts it exists to
   * catch: `Here is the translation: …` used to flush at `Here is the`, so the
   * cleaner never saw the colon it needed and `translation: …` streamed
   * straight to the panel. Holding continues only while something specific is
   * still resolving, so clean output pays nothing.
   */
  private shouldHold(): boolean {
    const buffer = this.buffer;
    if (buffer.length >= this.maxBuffer) return false;

    // An echo of the source, still arriving. Only a complete prefix can be
    // stripped, so there is nothing to do until the source is consumed or the
    // text diverges from it.
    const trimmed = buffer.trim();
    if (
      this.source &&
      trimmed.length > 0 &&
      trimmed.length < this.source.length &&
      this.source.toLowerCase().startsWith(trimmed.toLowerCase())
    ) {
      return true;
    }

    // Narration that has not reached the delimiter the cleaner splits on — the
    // colon of `Here is the translation:`, or the newline after `</think>`.
    if (isAIThinking(buffer) && !/[\n:：]/.test(buffer)) return true;

    return buffer.length <= this.threshold && !buffer.includes('\n');
  }

  /**
   * Feed one delta. Returns the text to emit now: '' while the opening bytes
   * are still buffered, the cleaned opening once it flushes, or the transformed
   * delta directly once past the buffering phase.
   */
  push(delta: string): string {
    if (!this.buffering) {
      let text = delta;
      if (this.trimNext) {
        // Dropping `Hello world` from `Hello world 你好世界` leaves the space
        // that separated them; painting it would indent the translation.
        text = text.replace(/^\s+/, '');
        if (text) this.trimNext = false;
      }
      return text ? this.transform.push(text) : '';
    }
    this.buffer += delta;
    return this.shouldHold() ? '' : this.flush();
  }

  /**
   * Flush any buffered opening text and whatever the transform is still
   * holding. Call once when the stream ends.
   */
  end(): string {
    const opening =
      this.buffering && this.buffer.length > 0 ? this.flush() : '';
    return opening + this.transform.end();
  }

  private flush(): string {
    const raw = this.buffer;
    // Unconditional: `cleanAIArtifacts` is a no-op on an opening that matches
    // no narration pattern, and running it only when `isAIThinking` fired meant
    // quote unwrapping never ran at all.
    let clean = cleanAIArtifacts(raw, true);
    if (this.source) clean = stripEcho(this.source, clean);
    // Both cleaners trim. When that was the only thing they did, keep the
    // buffer verbatim: the flush is often triggered *by* a newline, and
    // swallowing it would join the first two lines of a multi-line translation.
    if (clean === raw.trim()) clean = raw;
    this.buffering = false;
    this.buffer = '';
    this.trimNext = clean.length < raw.length;
    return clean ? this.transform.push(clean) : '';
  }
}
