import { describe, it, expect } from 'vitest';
import {
  corsFixCommand,
  describeConnection,
  modelIsInstalled,
  type ConnectionProbe,
} from './diagnostics';

const OPTS = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:latest',
  os: 'win' as const,
};

describe('modelIsInstalled', () => {
  it('matches an exact tagged name', () => {
    expect(modelIsInstalled('qwen3:latest', ['qwen3:latest'])).toBe(true);
  });

  it('treats a bare name as its :latest tag, the way Ollama resolves it', () => {
    // The bug this pins: comparing raw strings warns "qwen3 is not installed"
    // at a server that reports qwen3:latest and serves it perfectly.
    expect(modelIsInstalled('qwen3', ['qwen3:latest'])).toBe(true);
    expect(modelIsInstalled('qwen3:latest', ['qwen3'])).toBe(true);
  });

  it('does not match a different tag of the same model', () => {
    expect(modelIsInstalled('qwen3:8b', ['qwen3:latest'])).toBe(false);
  });

  it('does not match a prefix', () => {
    expect(modelIsInstalled('qwen', ['qwen3:latest'])).toBe(false);
  });

  it('ignores surrounding whitespace on either side', () => {
    expect(modelIsInstalled('  qwen3 ', ['qwen3:latest '])).toBe(true);
  });

  it('is false against an empty server', () => {
    expect(modelIsInstalled('qwen3', [])).toBe(false);
  });
});

describe('corsFixCommand', () => {
  it('gives each platform a command that platform can actually run', () => {
    expect(corsFixCommand('mac')).toContain('launchctl setenv');
    expect(corsFixCommand('win')).toContain('setx');
    expect(corsFixCommand('linux')).toContain('ollama serve');
    expect(corsFixCommand('other')).toContain('ollama serve');
  });

  it('always sets the origin the extension actually presents', () => {
    for (const os of ['mac', 'win', 'linux', 'other'] as const) {
      expect(corsFixCommand(os)).toContain('chrome-extension://*');
    }
  });
});

describe('describeConnection', () => {
  it('reports a healthy server with its model count', () => {
    const probe: ConnectionProbe = {
      kind: 'ok',
      models: ['qwen3:latest', 'llama3.1:latest'],
    };
    const report = describeConnection(probe, OPTS);
    expect(report.tone).toBe('ok');
    expect(report.message).toContain('2 models');
    expect(report.fix).toBeUndefined();
  });

  it('says "1 model", not "1 models"', () => {
    const report = describeConnection(
      { kind: 'ok', models: ['qwen3:latest'] },
      OPTS,
    );
    expect(report.message).toContain('1 model available');
  });

  it('turns a 403 into the one setting that fixes it', () => {
    const report = describeConnection({ kind: 'forbidden' }, OPTS);
    expect(report.tone).toBe('error');
    expect(report.message).toContain('403');
    expect(report.fix).toBe(corsFixCommand('win'));
  });

  it('tailors the 403 fix to the reported platform', () => {
    const mac = describeConnection(
      { kind: 'forbidden' },
      { ...OPTS, os: 'mac' },
    );
    expect(mac.fix).toContain('launchctl');
  });

  it('names the URL it could not reach', () => {
    const report = describeConnection({ kind: 'unreachable' }, OPTS);
    expect(report.tone).toBe('error');
    expect(report.message).toContain('http://localhost:11434');
    expect(report.fix).toBe('ollama serve');
  });

  it('passes an unexpected status through rather than guessing', () => {
    const report = describeConnection({ kind: 'http', status: 500 }, OPTS);
    expect(report.tone).toBe('error');
    expect(report.message).toContain('500');
    expect(report.fix).toBeUndefined();
  });

  it('warns when the server is up but has no models at all', () => {
    const report = describeConnection({ kind: 'ok', models: [] }, OPTS);
    expect(report.tone).toBe('warn');
    expect(report.fix).toBe('ollama pull qwen3');
  });

  it('warns when the configured model is the one thing missing', () => {
    // The silent failure this replaces: a typo in a free-text field surfaced
    // as a 404 only after the user selected text on a page.
    const report = describeConnection(
      { kind: 'ok', models: ['llama3.1:latest'] },
      { ...OPTS, model: 'qwen3:latst' },
    );
    expect(report.tone).toBe('warn');
    expect(report.message).toContain('qwen3:latst');
    expect(report.fix).toBe('ollama pull qwen3:latst');
  });

  it('does not warn about a blank model field', () => {
    // Blank means "fall back to the default", which is a valid state to save.
    const report = describeConnection(
      { kind: 'ok', models: ['llama3.1:latest'] },
      { ...OPTS, model: '   ' },
    );
    expect(report.tone).toBe('ok');
  });
});
