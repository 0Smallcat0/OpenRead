import { describe, it, expect } from 'vitest';
import { buildOriginStripRule, ORIGIN_STRIP_RULE_ID } from './dnr-rule';

describe('buildOriginStripRule', () => {
  it('removes the Origin header, which is the whole 403', () => {
    // Measured against a stock Ollama: no Origin -> 200, extension Origin ->
    // 403. Stripping the header is what makes OLLAMA_ORIGINS unnecessary.
    const rule = buildOriginStripRule('http://localhost:11434');
    expect(rule?.action.type).toBe('modifyHeaders');
    expect(rule?.action.requestHeaders).toEqual([
      { header: 'origin', operation: 'remove' },
    ]);
  });

  it('only matches requests with no owning tab', () => {
    // The security boundary. Origin is what stops a web page from driving a
    // local model; a page request always carries a real tab id, so it cannot
    // match this rule and keeps facing Ollama's own check.
    expect(
      buildOriginStripRule('http://localhost:11434')?.condition.tabIds,
    ).toEqual([-1]);
  });

  it('anchors to the configured origin so a lookalike host cannot match', () => {
    const rule = buildOriginStripRule('http://localhost:11434');
    // Without the leading `|`, "evil.com/?x=http://localhost:11434/" matches.
    expect(rule?.condition.urlFilter).toBe('|http://localhost:11434/');
  });

  it('follows a custom server rather than assuming localhost', () => {
    const rule = buildOriginStripRule('http://192.168.1.10:11434');
    expect(rule?.condition.urlFilter).toBe('|http://192.168.1.10:11434/');
  });

  it('normalises a URL with a path or trailing slash down to its origin', () => {
    for (const input of [
      'http://localhost:11434/',
      'http://localhost:11434/api',
      'http://localhost:11434/api/chat',
    ]) {
      expect(buildOriginStripRule(input)?.condition.urlFilter).toBe(
        '|http://localhost:11434/',
      );
    }
  });

  it('keeps https distinct from http', () => {
    expect(
      buildOriginStripRule('https://ollama.example.com')?.condition.urlFilter,
    ).toBe('|https://ollama.example.com/');
  });

  it('uses a fixed id, so an update replaces the rule instead of stacking', () => {
    expect(buildOriginStripRule('http://localhost:11434')?.id).toBe(
      ORIGIN_STRIP_RULE_ID,
    );
    expect(buildOriginStripRule('http://elsewhere:11434')?.id).toBe(
      ORIGIN_STRIP_RULE_ID,
    );
  });

  it('installs nothing rather than something malformed', () => {
    // Degrading to the 403 the popup already explains is safe. A malformed
    // rule is not: it could match more than the configured server.
    for (const bad of ['', 'not a url', 'localhost:11434', '   ']) {
      expect(buildOriginStripRule(bad)).toBeNull();
    }
  });

  it('refuses schemes that have no meaningful origin', () => {
    expect(buildOriginStripRule('data:text/plain,hello')).toBeNull();
    expect(buildOriginStripRule('about:blank')).toBeNull();
  });

  it('never widens past xmlhttprequest', () => {
    expect(
      buildOriginStripRule('http://localhost:11434')?.condition.resourceTypes,
    ).toEqual(['xmlhttprequest']);
  });
});
