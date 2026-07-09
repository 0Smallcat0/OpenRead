import { describe, it, expect } from 'vitest';
import {
  buildEnrichMessages,
  parseEnrichResponse,
  ENRICH_INPUT_LIMIT,
} from './enrich';

describe('buildEnrichMessages', () => {
  it('names the target language in the system prompt', () => {
    const [system] = buildEnrichMessages('hello', 'Traditional Chinese');
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('Traditional Chinese');
  });

  it('truncates the source text to the input limit', () => {
    const long = 'x'.repeat(ENRICH_INPUT_LIMIT + 500);
    const messages = buildEnrichMessages(long, 'English');
    const user = messages[messages.length - 1];
    expect(user?.content.length).toBe(ENRICH_INPUT_LIMIT);
  });
});

describe('parseEnrichResponse', () => {
  it('parses a clean JSON object', () => {
    const out = parseEnrichResponse(
      '{"title":"Linear time","summary":"It runs in O(n).","tags":["algorithms","performance"]}',
    );
    expect(out).toEqual({
      title: 'Linear time',
      summary: 'It runs in O(n).',
      tags: ['algorithms', 'performance'],
    });
  });

  it('recovers JSON wrapped in a code fence', () => {
    const out = parseEnrichResponse(
      '```json\n{"title":"Fenced","tags":["a"]}\n```',
    );
    expect(out?.title).toBe('Fenced');
    expect(out?.tags).toEqual(['a']);
  });

  it('recovers JSON buried in preamble and trailing prose', () => {
    const out = parseEnrichResponse(
      'Sure, here is the metadata: {"summary":"A note."} Hope this helps!',
    );
    expect(out?.summary).toBe('A note.');
  });

  it('accepts tags given as a comma-separated string', () => {
    const out = parseEnrichResponse('{"tags":"ml, nlp, models"}');
    expect(out?.tags).toEqual(['ml', 'nlp', 'models']);
  });

  it('normalises hashes, spaces, and case in tags and dedupes', () => {
    const out = parseEnrichResponse(
      '{"tags":["#Machine Learning","machine-learning","AI"]}',
    );
    expect(out?.tags).toEqual(['machine-learning', 'ai']);
  });

  it('strips wrapping quotes from scalar fields', () => {
    const out = parseEnrichResponse('{"title":"「引號」"}');
    expect(out?.title).toBe('引號');
  });

  it('caps tags at six', () => {
    const out = parseEnrichResponse(
      '{"tags":["a","b","c","d","e","f","g","h"]}',
    );
    expect(out?.tags?.length).toBe(6);
  });

  it('returns null for an empty string', () => {
    expect(parseEnrichResponse('')).toBeNull();
  });

  it('returns null when there is no JSON object', () => {
    expect(parseEnrichResponse('I cannot help with that.')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    expect(parseEnrichResponse('["a","b"]')).toBeNull();
  });

  it('returns null when no field is usable', () => {
    expect(parseEnrichResponse('{"title":"","tags":[]}')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseEnrichResponse('{"title": unterminated')).toBeNull();
  });
});
