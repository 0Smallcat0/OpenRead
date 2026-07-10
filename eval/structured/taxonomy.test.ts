import { describe, expect, it } from 'vitest';
import { classifyReply } from './taxonomy';

const OBJ = '{"title": "固態電池", "summary": "量產瓶頸與時程。", "tags": ["電池"]}';

describe('classifyReply', () => {
  it('classifies clean JSON', () => {
    expect(classifyReply(OBJ)).toBe('clean-json');
    expect(classifyReply(`  ${OBJ}\n`)).toBe('clean-json');
  });

  it('classifies fenced JSON', () => {
    expect(classifyReply('```json\n' + OBJ + '\n```')).toBe('fenced-json');
    expect(classifyReply('```\n' + OBJ + '\n```')).toBe('fenced-json');
  });

  it('classifies JSON after visible thinking', () => {
    expect(
      classifyReply(`<think>The user wants metadata.</think>\n${OBJ}`),
    ).toBe('thinking-then-json');
  });

  it('classifies JSON wrapped in prose', () => {
    expect(classifyReply(`Here is the metadata you asked for:\n${OBJ}`)).toBe(
      'json-with-prose',
    );
    expect(classifyReply(`${OBJ}\nLet me know if you need anything else!`)).toBe(
      'json-with-prose',
    );
  });

  it('classifies truncated JSON', () => {
    expect(classifyReply('{"title": "固態電池", "summary": "量產')).toBe(
      'truncated-json',
    );
    // Balanced braces but unparseable content is still a truncation-class defect.
    expect(classifyReply('{"title": broken}')).toBe('truncated-json');
  });

  it('classifies pure prose and refusals as no-json', () => {
    expect(classifyReply('I cannot label this text.')).toBe('no-json');
    expect(classifyReply('固態電池是下一代電動車關鍵技術。')).toBe('no-json');
  });

  it('classifies empty and whitespace-only replies', () => {
    expect(classifyReply('')).toBe('empty');
    expect(classifyReply('   \n ')).toBe('empty');
  });

  it('prefers fence over prose when both would match', () => {
    expect(
      classifyReply('Sure! Here you go:\n```json\n' + OBJ + '\n```\nEnjoy!'),
    ).toBe('fenced-json');
  });
});
