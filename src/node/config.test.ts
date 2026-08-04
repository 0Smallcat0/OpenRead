import { describe, it, expect } from 'vitest';
import { resolveConfig, normaliseHost, DEFAULTS } from './config';
import { DEFAULT_SETTINGS } from '../settings';

describe('DEFAULTS', () => {
  it('matches what the extension ships', () => {
    // Two front doors onto one pipeline. If the CLI translated with a
    // different model or into a different language than the extension, the
    // same text would come back different depending on how you asked, and
    // nothing else in the project would notice.
    expect(DEFAULTS.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
    expect(DEFAULTS.model).toBe(DEFAULT_SETTINGS.modelId);
    expect(DEFAULTS.targetLang).toBe(DEFAULT_SETTINGS.targetLang);
  });
});

describe('normaliseHost', () => {
  it('accepts the bare form OLLAMA_HOST is conventionally set to', () => {
    expect(normaliseHost('127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(normaliseHost('nas.local')).toBe('http://nas.local');
  });

  it('leaves an explicit scheme alone', () => {
    expect(normaliseHost('https://ollama.example.com')).toBe(
      'https://ollama.example.com',
    );
  });

  it('reduces a URL with a path to its origin', () => {
    expect(normaliseHost('http://localhost:11434/api/chat')).toBe(
      'http://localhost:11434',
    );
  });

  it('treats blank and unparseable values as unset', () => {
    for (const value of [undefined, '', '   ', 'http://']) {
      expect(normaliseHost(value)).toBeUndefined();
    }
  });
});

describe('resolveConfig', () => {
  it('falls back to the defaults with nothing supplied', () => {
    expect(resolveConfig({}, {})).toEqual(DEFAULTS);
  });

  it('lets a flag win over the environment', () => {
    const config = resolveConfig(
      { model: 'llama3.1' },
      { OPENREAD_MODEL: 'qwen3.5' },
    );
    expect(config.model).toBe('llama3.1');
  });

  it('lets the environment win over the defaults', () => {
    const config = resolveConfig(
      {},
      { OPENREAD_LANG: 'Japanese', OPENREAD_MODEL: 'gemma3' },
    );
    expect(config.targetLang).toBe('Japanese');
    expect(config.model).toBe('gemma3');
  });

  it('reads OLLAMA_HOST, which a remote user has already set', () => {
    // Asking someone to set a second variable meaning the same thing is the
    // kind of small tax the previous release was spent removing.
    expect(resolveConfig({}, { OLLAMA_HOST: '10.0.0.5:11434' }).baseUrl).toBe(
      'http://10.0.0.5:11434',
    );
  });

  it('prefers OPENREAD_URL over OLLAMA_HOST', () => {
    const config = resolveConfig(
      {},
      { OPENREAD_URL: 'http://a:1', OLLAMA_HOST: 'b:2' },
    );
    expect(config.baseUrl).toBe('http://a:1');
  });

  it('ignores an unparseable OLLAMA_HOST rather than passing it on', () => {
    expect(resolveConfig({}, { OLLAMA_HOST: 'http://' }).baseUrl).toBe(
      DEFAULTS.baseUrl,
    );
  });
});
