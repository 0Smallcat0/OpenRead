import { describe, it, expect } from 'vitest';
import {
  parseGlossary,
  serializeGlossary,
  protectTerms,
  restoreTerms,
  hasGlossaryTerm,
  MAX_TOKENS,
} from './glossary';

describe('parseGlossary', () => {
  it('reads a bare term as "leave it alone"', () => {
    expect(parseGlossary('OpenRead')).toEqual([{ term: 'OpenRead', as: '' }]);
  });

  it('reads term = replacement', () => {
    expect(parseGlossary('React = React')).toEqual([
      { term: 'React', as: 'React' },
    ]);
    expect(parseGlossary('bug = 瑕疵')).toEqual([{ term: 'bug', as: '瑕疵' }]);
  });

  it('keeps everything after the first = , so a replacement may contain one', () => {
    expect(parseGlossary('a = b = c')).toEqual([{ term: 'a', as: 'b = c' }]);
  });

  it('ignores blank lines and comments', () => {
    const raw = ['# names', '', 'OpenRead', '   ', '# end'].join('\n');
    expect(parseGlossary(raw)).toEqual([{ term: 'OpenRead', as: '' }]);
  });

  it('drops a line with no term, rather than matching everything', () => {
    expect(parseGlossary(' = 中文')).toEqual([]);
  });

  it('keeps the first of two rules for the same term', () => {
    expect(parseGlossary('React = 甲\nreact = 乙')).toEqual([
      { term: 'React', as: '甲' },
    ]);
  });

  it('round trips through serialize', () => {
    const raw = 'OpenRead\nReact Native = React Native\nbug = 瑕疵';
    expect(serializeGlossary(parseGlossary(raw))).toBe(raw);
  });
});

describe('protectTerms', () => {
  it('does nothing without entries, and costs nothing', () => {
    const hidden = protectTerms('React is a library.', []);
    expect(hidden.text).toBe('React is a library.');
    expect(hidden.values).toEqual([]);
  });

  it('hides a term behind a placeholder', () => {
    const hidden = protectTerms('React is a library.', [
      { term: 'React', as: '' },
    ]);
    expect(hidden.text).toBe('[[0]] is a library.');
    expect(hidden.values).toEqual(['React']);
  });

  it('matches case-insensitively but restores the glossary spelling', () => {
    const hidden = protectTerms('openread is fast.', [
      { term: 'OpenRead', as: '' },
    ]);
    expect(hidden.text).toBe('[[0]] is fast.');
    expect(restoreTerms(hidden.text, hidden).text).toBe('OpenRead is fast.');
  });

  it('will not fire inside a longer word', () => {
    const hidden = protectTerms('He said it was AI.', [{ term: 'AI', as: '' }]);
    expect(hidden.text).toBe('He said it was [[0]].');
  });

  it('matches a CJK term with no word boundary around it', () => {
    // 資料庫 has no word edge inside 建立資料庫時; a boundary assertion would
    // match nothing, which is the whole reason boundaries are conditional.
    const hidden = protectTerms('建立資料庫時要注意。', [
      { term: '資料庫', as: 'database' },
    ]);
    expect(hidden.text).toBe('建立[[0]]時要注意。');
    expect(hidden.values).toEqual(['database']);
  });

  it('prefers the longer term when two overlap', () => {
    const hidden = protectTerms('React Native and React', [
      { term: 'React', as: 'A' },
      { term: 'React Native', as: 'B' },
    ]);
    expect(hidden.values).toEqual(['B', 'A']);
    expect(restoreTerms(hidden.text, hidden).text).toBe('B and A');
  });

  it('gives every occurrence its own token', () => {
    const hidden = protectTerms('React, then React again.', [
      { term: 'React', as: '' },
    ]);
    expect(hidden.text).toBe('[[0]], then [[1]] again.');
  });

  it('never reuses a token number the text already contains', () => {
    const hidden = protectTerms('See [[0]] and [[1]]: React.', [
      { term: 'React', as: '' },
    ]);
    expect(hidden.text).toBe('See [[0]] and [[1]]: [[2]].');
    expect(restoreTerms(hidden.text, hidden).text).toBe(
      'See [[0]] and [[1]]: React.',
    );
  });

  it('stops at MAX_TOKENS rather than turning prose into token soup', () => {
    const text = Array.from({ length: MAX_TOKENS + 10 }, () => 'React').join(
      ' ',
    );
    const hidden = protectTerms(text, [{ term: 'React', as: '' }]);
    expect(hidden.values).toHaveLength(MAX_TOKENS);
    expect(hidden.text).toContain('React');
  });
});

describe('restoreTerms', () => {
  const hide = (text: string) =>
    protectTerms(text, [{ term: 'React', as: 'React' }]);

  it('puts the term back where the translator left the token', () => {
    const hidden = hide('React is fast.');
    const out = restoreTerms('[[0]] 很快。', hidden);
    expect(out).toEqual({ text: 'React 很快。', complete: true });
  });

  it('tolerates whitespace the translator added inside the token', () => {
    const hidden = hide('React is fast.');
    // Arabic did exactly this to other placeholder shapes: `#0#` came back
    // as `# 0 #`.
    expect(restoreTerms('[[ 0 ]] سريع.', hidden).text).toBe('React سريع.');
  });

  it('reports incomplete when a token was dropped', () => {
    const hidden = hide('React is fast.');
    const out = restoreTerms('很快。', hidden);
    expect(out.complete).toBe(false);
  });

  it('reports incomplete when a token came back twice', () => {
    const hidden = hide('React is fast.');
    expect(restoreTerms('[[0]] 和 [[0]] 很快。', hidden).complete).toBe(false);
  });

  it('leaves a token it never issued alone', () => {
    const hidden = hide('React is fast.');
    const out = restoreTerms('[[0]] 見 [[9]]。', hidden);
    expect(out.text).toBe('React 見 [[9]]。');
    expect(out.complete).toBe(true);
  });

  it('is a no-op when nothing was hidden', () => {
    expect(
      restoreTerms('anything [[3]]', { text: '', values: [], indices: [] }),
    ).toEqual({ text: 'anything [[3]]', complete: true });
  });
});

describe('hasGlossaryTerm', () => {
  it('answers without building the protected text', () => {
    const entries = [{ term: 'React', as: '' }];
    expect(hasGlossaryTerm('React is a library', entries)).toBe(true);
    expect(hasGlossaryTerm('nothing here', entries)).toBe(false);
  });

  it('is not confused by the lastIndex of a global regex', () => {
    // Two calls in a row with the same entry: a shared /g regex would answer
    // true then false, because `test` advances `lastIndex`.
    const entries = [{ term: 'React', as: '' }];
    expect(hasGlossaryTerm('React React', entries)).toBe(true);
    expect(hasGlossaryTerm('React React', entries)).toBe(true);
  });
});
