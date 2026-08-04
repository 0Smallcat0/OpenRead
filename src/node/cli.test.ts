import { describe, it, expect } from 'vitest';
import { parseArgs } from './cli';

describe('parseArgs', () => {
  it('treats bare words as the text to translate', () => {
    const args = parseArgs(['Hello', 'world']);
    expect(args.command).toBe('translate');
    expect(args.text).toBe('Hello world');
  });

  it('defaults to reading stdin when given no text', () => {
    expect(parseArgs([]).text).toBeUndefined();
  });

  it('accepts both the short and long form of every option', () => {
    const long = parseArgs([
      '--to',
      'Japanese',
      '--model',
      'gemma3',
      '--url',
      'http://x:1',
      '--file',
      'a.md',
    ]);
    const short = parseArgs([
      '-t',
      'Japanese',
      '-m',
      'gemma3',
      '-u',
      'http://x:1',
      '-f',
      'a.md',
    ]);
    expect(long).toEqual(short);
    expect(long.flags).toEqual({
      targetLang: 'Japanese',
      model: 'gemma3',
      baseUrl: 'http://x:1',
    });
    expect(long.file).toBe('a.md');
  });

  it('rejects a typo instead of translating it', () => {
    // The failure this prevents: `--modle qwen3` parsed as text, quietly
    // translating the word "qwen3" with the default model and reporting
    // success.
    expect(parseArgs(['--modle', 'qwen3']).error).toContain('--modle');
  });

  it('rejects an option whose value is missing', () => {
    expect(parseArgs(['--to']).error).toContain('--to');
    expect(parseArgs(['Hello', '--model']).error).toContain('--model');
  });

  it('recognises the subcommands', () => {
    expect(parseArgs(['mcp']).command).toBe('mcp');
    expect(parseArgs(['models']).command).toBe('models');
  });

  it('only treats a subcommand as one when it comes first', () => {
    // "translate the word models" has to stay possible.
    expect(parseArgs(['translate', 'models']).command).toBe('translate');
    expect(parseArgs(['the', 'mcp', 'protocol']).text).toBe('the mcp protocol');
  });

  it('short-circuits on help and version, whatever else was passed', () => {
    expect(parseArgs(['some', 'text', '--help']).command).toBe('help');
    expect(parseArgs(['-V', '--to', 'Japanese']).command).toBe('version');
  });

  it('streams by default and buffers on request', () => {
    expect(parseArgs(['hi']).stream).toBe(true);
    expect(parseArgs(['hi', '--quiet']).stream).toBe(false);
    expect(parseArgs(['hi', '-q']).stream).toBe(false);
  });

  it('leaves a lone dash as text rather than calling it an option', () => {
    expect(parseArgs(['-']).error).toBeUndefined();
  });
});
