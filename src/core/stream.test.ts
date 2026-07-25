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
    const upper = {
      transform: {
        push: (c: string) => c.toUpperCase(),
        end: () => '',
      },
    };
    // First delta contains a newline, forcing an immediate flush.
    expect(run(['ab\n', 'cd'], upper)).toBe('AB\nCD');
  });

  it('flushes text the transform held back when the stream ends', () => {
    // A phrase-aware transform withholds an ambiguous tail; end() must emit it.
    let held = '';
    const holdLast = {
      transform: {
        push: (c: string) => {
          const out = held;
          held = c;
          return out;
        },
        end: () => held,
      },
    };
    expect(run(['abcdefghijklm', 'nop'], holdLast)).toBe('abcdefghijklmnop');
  });

  it('emits nothing while still buffering below threshold', () => {
    const asm = new StreamAssembler();
    expect(asm.push('hi')).toBe('');
  });
});

/**
 * Twelve characters is shorter than the artifacts the buffer exists to catch,
 * so it used to flush mid-artifact and let the tail stream to the panel. These
 * are the exact fixtures the offline eval scores.
 */
describe('holding until an artifact resolves', () => {
  /** Feed in small slices so boundaries land mid-artifact, as a real stream does. */
  function stream(
    output: string,
    opts?: ConstructorParameters<typeof StreamAssembler>[0],
  ): string {
    const asm = new StreamAssembler(opts);
    let out = '';
    for (let i = 0; i < output.length; i += 3)
      out += asm.push(output.slice(i, i + 3));
    return out + asm.end();
  }

  it('waits for the colon before deciding where the preamble ends', () => {
    // Flushing at 12 chars gave "translation: 關閉前請先儲存您的工作。"
    expect(stream('Here is the translation: 關閉前請先儲存您的工作。')).toBe(
      '關閉前請先儲存您的工作。',
    );
  });

  it('waits out a thinking block instead of flushing inside it', () => {
    expect(
      stream(
        '<think>The user is asking me to translate this sentence.</think>\n加密可以保護您的資料。',
      ),
    ).toBe('加密可以保護您的資料。');
  });

  it('removes an echo of the source when the source is supplied', () => {
    expect(stream('Hello world 你好世界', { source: 'Hello world' })).toBe(
      '你好世界',
    );
  });

  it('leaves the echo in place when no source is supplied', () => {
    // Echo is only recognisable against the thing being echoed.
    expect(stream('Hello world 你好世界')).toBe('Hello world 你好世界');
  });

  it('does not mistake a translation that merely starts like the source', () => {
    expect(
      stream('Firefox 是一個瀏覽器', { source: 'Firefox is a browser' }),
    ).toBe('Firefox 是一個瀏覽器');
  });

  it('holds nothing extra for clean output', () => {
    // The whole point: the wait is paid only when something is actually
    // forming. First paint on clean output is unchanged.
    const withSource = new StreamAssembler({
      source: 'The algorithm is fast.',
    });
    const without = new StreamAssembler();
    const output = '這個演算法很快。';
    let a = 0;
    let b = 0;
    for (let i = 0; i < output.length; i += 3) {
      if (!a && withSource.push(output.slice(i, i + 3))) a = i + 3;
      if (!b && without.push(output.slice(i, i + 3))) b = i + 3;
    }
    expect(a).toBe(b);
  });

  it('gives up holding at maxBuffer so first paint cannot stall', () => {
    // An opening that looks like narration but never reaches a delimiter.
    const output = `Here is the ${'x'.repeat(200)}`;
    expect(stream(output, { maxBuffer: 40 }).length).toBeGreaterThan(0);
  });

  it('keeps a line break that happens to fall at the flush point', () => {
    // The cleaners trim; when trimming is all they did the buffer must survive
    // verbatim, or the first two lines of a multi-line translation merge.
    expect(stream('第一行第二行第三行\n第四行')).toBe(
      '第一行第二行第三行\n第四行',
    );
  });
});
