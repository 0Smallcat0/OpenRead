import { describe, it, expect } from 'vitest';
import { StreamAssembler } from './stream';

/** Drive an assembler with a list of deltas and collect all emitted text. */
function run(
  deltas: string[],
  opts?: ConstructorParameters<typeof StreamAssembler>[0],
) {
  const asm = new StreamAssembler(opts);
  let out = '';
  for (const d of deltas) out += asm.push(d);
  out += asm.end();
  return out;
}

describe('StreamAssembler', () => {
  it('buffers the opening until the threshold, then streams through', () => {
    // "Hello world!!" exceeds the 12-char threshold on the last delta.
    expect(run(['Hel', 'lo ', 'wor', 'ld!', '!'])).toBe('Hello world!!');
  });

  it('strips a preamble that appears in the buffered opening', () => {
    const out = run(['Sure, here is the translation:\n', '你好世界']);
    expect(out).toBe('你好世界');
  });

  it('flushes a short final buffer via end() when the stream closes early', () => {
    expect(run(['你好'])).toBe('你好');
  });

  it('applies the transform to both the opening and later chunks', () => {
    const upper = { transform: (c: string) => c.toUpperCase() };
    // First delta contains a newline, forcing an immediate flush.
    expect(run(['ab\n', 'cd'], upper)).toBe('AB\nCD');
  });

  it('emits nothing while still buffering below threshold', () => {
    const asm = new StreamAssembler();
    expect(asm.push('hi')).toBe('');
  });
});
