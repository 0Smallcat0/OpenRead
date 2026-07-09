import { describe, it, expect } from 'vitest';
import {
  isAIThinking,
  cleanAIArtifacts,
  stripEcho,
  cleanTranslationOutput,
} from './sanitize';

describe('isAIThinking', () => {
  it('flags English narration prefixes', () => {
    expect(isAIThinking('The user wants a translation')).toBe(true);
    expect(isAIThinking('Sure, here is the translation')).toBe(true);
  });

  it('flags Chinese narration prefixes', () => {
    expect(isAIThinking('好的,這段文字翻譯如下')).toBe(true);
  });

  it('does not flag a genuine translation', () => {
    expect(isAIThinking('法國的首都是巴黎')).toBe(false);
  });
});

describe('cleanAIArtifacts', () => {
  it('drops a leading thinking paragraph split by a blank line', () => {
    const raw = 'The user wants a translation.\n\n法國的首都是巴黎';
    expect(cleanAIArtifacts(raw, true)).toBe('法國的首都是巴黎');
  });

  it('strips an inline "Translation:" label with no blank line', () => {
    expect(cleanAIArtifacts('Translation: 你好世界', true)).toBe('你好世界');
  });

  it('unwraps symmetric quotes on any chunk', () => {
    expect(cleanAIArtifacts('"你好世界"')).toBe('你好世界');
    expect(cleanAIArtifacts('「你好世界」')).toBe('你好世界');
  });

  it('leaves clean text untouched', () => {
    expect(cleanAIArtifacts('你好世界', true)).toBe('你好世界');
  });
});

describe('stripEcho', () => {
  it('removes an echoed input prefix case-insensitively', () => {
    expect(stripEcho('Hello world', 'Hello world 你好世界')).toBe('你好世界');
  });

  it('returns output unchanged when there is no echo', () => {
    expect(stripEcho('Hello world', '你好世界')).toBe('你好世界');
  });

  it('handles empty input by trimming output', () => {
    expect(stripEcho('', '  你好世界  ')).toBe('你好世界');
  });
});

describe('cleanTranslationOutput', () => {
  it('strips preamble and echo together', () => {
    const out = cleanTranslationOutput(
      'Hello world',
      'Sure, here is the translation:\n\nHello world 你好世界',
    );
    expect(out).toBe('你好世界');
  });

  it('skips echo removal when input is null', () => {
    expect(cleanTranslationOutput(null, '"你好世界"')).toBe('你好世界');
  });
});
