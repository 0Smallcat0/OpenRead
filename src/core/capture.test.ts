import { describe, it, expect } from 'vitest';
import {
  buildMarkdown,
  captureFilename,
  buildObsidianUri,
  resolveSourceUrl,
  applyEnrichment,
} from './capture';
import type { CaptureNote } from './types';

const base: CaptureNote = {
  title: 'The Title',
  source: 'Example Page',
  url: 'https://example.com/a',
  capturedAt: '2026-07-09T13:05:22.123Z',
  from: 'auto',
  to: 'Traditional Chinese',
  original: 'Hello world',
  translation: '你好世界',
  tags: ['openread'],
  status: 'raw',
};

describe('buildMarkdown', () => {
  it('emits YAML frontmatter with the handoff fields', () => {
    const md = buildMarkdown(base);
    expect(md).toContain('title: "The Title"');
    expect(md).toContain('url: https://example.com/a');
    expect(md).toContain('captured: 2026-07-09T13:05:22.123Z');
    expect(md).toContain('status: raw');
    expect(md).toContain('tags: [openread]');
  });

  it('escapes double quotes in quoted scalars', () => {
    const md = buildMarkdown({ ...base, source: 'A "quoted" title' });
    expect(md).toContain('source: "A \\"quoted\\" title"');
  });

  it('blockquotes a multi-line original', () => {
    const md = buildMarkdown({ ...base, original: 'line one\nline two' });
    expect(md).toContain('> line one\n> line two');
  });

  it('includes a Summary section only when present', () => {
    expect(buildMarkdown(base)).not.toContain('## Summary');
    expect(buildMarkdown({ ...base, summary: 'A recap.' })).toContain(
      '## Summary\n\nA recap.',
    );
  });
});

describe('captureFilename', () => {
  it('appends a compact timestamp', () => {
    expect(captureFilename(base)).toBe('The Title 20260709-1305');
  });

  it('strips characters illegal in a vault filename', () => {
    const name = captureFilename({ ...base, title: 'a/b:c*d?"e"' });
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('falls back to "capture" when the title is empty', () => {
    const name = captureFilename({ ...base, title: '', source: '' });
    expect(name.startsWith('capture ')).toBe(true);
  });
});

describe('buildObsidianUri', () => {
  it('encodes spaces as %20, not +', () => {
    const uri = buildObsidianUri({
      vault: 'My Vault',
      folder: 'OpenRead',
      filename: 'note one',
      content: 'a b',
    });
    expect(uri).toContain('vault=My%20Vault');
    expect(uri).toContain('file=OpenRead%2Fnote%20one');
    expect(uri).toContain('content=a%20b');
    expect(uri).not.toContain('+');
  });

  it('omits the vault param when no vault is given', () => {
    const uri = buildObsidianUri({ filename: 'x', content: 'y' });
    expect(uri).not.toContain('vault=');
    expect(uri.startsWith('obsidian://new?')).toBe(true);
  });
});

describe('resolveSourceUrl', () => {
  it('unwraps the PDF.js viewer URL to the real file', () => {
    const href =
      'chrome-extension://abc/pdfjs/web/viewer.html?file=https%3A%2F%2Farxiv.org%2Fp.pdf';
    expect(resolveSourceUrl(href)).toBe('https://arxiv.org/p.pdf');
  });

  it('passes a normal page URL through unchanged', () => {
    expect(resolveSourceUrl('https://example.com/a')).toBe(
      'https://example.com/a',
    );
  });
});

describe('applyEnrichment', () => {
  it('overrides the title and merges new tags without duplicates', () => {
    const out = applyEnrichment(base, {
      title: 'Better Title',
      tags: ['openread', 'ml'],
    });
    expect(out.title).toBe('Better Title');
    expect(out.tags).toEqual(['openread', 'ml']);
  });

  it('keeps the original title when enrichment has none', () => {
    const out = applyEnrichment(base, { summary: 'x' });
    expect(out.title).toBe('The Title');
    expect(out.summary).toBe('x');
  });

  it('does not mutate the input note', () => {
    applyEnrichment(base, { tags: ['ml'] });
    expect(base.tags).toEqual(['openread']);
  });
});
