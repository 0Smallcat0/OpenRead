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
import { isAIThinking, cleanAIArtifacts } from './sanitize';
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
   * a newline). Larger = safer preamble detection but slower first paint.
   */
  bufferThreshold?: number;
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

  constructor(options: StreamAssemblerOptions = {}) {
    this.transform = options.transform ?? PASS_THROUGH;
    this.threshold = options.bufferThreshold ?? 12;
  }

  /**
   * Feed one delta. Returns the text to emit now: '' while the opening bytes
   * are still buffered, the cleaned opening once it flushes, or the transformed
   * delta directly once past the buffering phase.
   */
  push(delta: string): string {
    if (!this.buffering) {
      return this.transform.push(delta);
    }
    this.buffer += delta;
    if (this.buffer.length > this.threshold || this.buffer.includes('\n')) {
      return this.flush();
    }
    return '';
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
    let clean = this.buffer;
    if (isAIThinking(clean)) {
      clean = cleanAIArtifacts(clean, true);
    }
    this.buffering = false;
    this.buffer = '';
    return clean ? this.transform.push(clean) : '';
  }
}
