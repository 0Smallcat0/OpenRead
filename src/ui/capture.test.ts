// @vitest-environment jsdom
/**
 * The capture path is where the product pays off — a note either lands in the
 * vault or it does not — and it was the last untested user-facing surface. The
 * side effects (protocol navigation, clipboard, the enrichment round-trip) are
 * observed here rather than mocked away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureNote, type CaptureConfig } from './capture';
import type { CaptureNote } from '../core/types';

const CONFIG: CaptureConfig = {
  vault: 'Second Brain',
  folder: 'OpenRead',
  enrich: false,
  model: 'qwen3:latest',
  targetLang: 'Traditional Chinese',
};

const BASE: CaptureNote = {
  title: 'Using the Fetch API - MDN Web Docs',
  source: 'Using the Fetch API - MDN Web Docs',
  url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
  capturedAt: '2026-07-25T16:10:00.000Z',
  from: 'auto',
  to: 'Traditional Chinese',
  original: 'The fetch() method starts the process of fetching a resource.',
  translation: 'fetch() 方法啟動從網路取得資源的過程。',
  tags: ['openread'],
  status: 'raw',
};

function noteOf(overrides: Partial<CaptureNote> = {}): CaptureNote {
  return Object.assign({ ...BASE }, overrides);
}

/** The href of the anchor the capture path clicked, if any. */
let navigatedTo: string | null;

beforeEach(() => {
  navigatedTo = null;
  // openUri() appends an <a>, clicks it, and removes it. jsdom does not
  // navigate, so intercept the click to record where it would have gone.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    navigatedTo = this.getAttribute('href');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('writing to Obsidian', () => {
  it('opens an obsidian://new URI carrying the vault, folder and note', async () => {
    const outcome = await captureNote(noteOf(), CONFIG);

    expect(outcome).toEqual({ ok: true, method: 'obsidian' });
    expect(navigatedTo).toMatch(/^obsidian:\/\/new\?/);
    const params = new URLSearchParams(navigatedTo?.split('?')[1]);
    expect(params.get('vault')).toBe('Second Brain');
    expect(params.get('file')).toMatch(/^OpenRead\//);
    expect(params.get('content')).toContain(
      'fetch() 方法啟動從網路取得資源的過程。',
    );
  });

  it('leaves the vault out when the user has not named one', async () => {
    await captureNote(noteOf(), { ...CONFIG, vault: '' });

    const params = new URLSearchParams(navigatedTo?.split('?')[1]);
    expect(params.has('vault')).toBe(false);
  });

  it('removes the anchor it used, leaving no trace on the page', async () => {
    await captureNote(noteOf(), CONFIG);

    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});

describe('notes too large for a protocol-handler URL', () => {
  // Percent-encoding Chinese costs 9 bytes a character, so the URI outgrows the
  // 8,000-char cap at roughly 1,500-2,200 characters of selection.
  const huge = noteOf({
    original: 'The fetch() method starts the process of fetching. '.repeat(60),
    translation: 'fetch() 方法啟動從網路取得資源的過程。'.repeat(60),
  });

  it('copies to the clipboard instead of losing content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const outcome = await captureNote(huge, CONFIG);

    expect(outcome).toEqual({ ok: true, method: 'clipboard' });
    expect(navigatedTo).toBeNull();
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'fetch() 方法啟動從網路取得資源的過程。',
    );
  });

  it('falls back to execCommand when the clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommand,
      configurable: true,
    });

    const outcome = await captureNote(huge, CONFIG);

    expect(outcome).toEqual({ ok: true, method: 'clipboard' });
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('reports failure rather than claiming a save that never happened', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });

    const outcome = await captureNote(huge, CONFIG);

    expect(outcome).toEqual({ ok: false, reason: 'copy-failed' });
  });
});

describe('optional local enrichment', () => {
  it('folds a successful enrichment into the note', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      result: {
        title: 'Fetch API 用法',
        summary: 'fetch() 取得網路資源的流程。',
        tags: ['web', 'api'],
      },
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await captureNote(noteOf(), { ...CONFIG, enrich: true });

    const content = new URLSearchParams(navigatedTo?.split('?')[1]).get(
      'content',
    );
    expect(content).toContain('fetch() 取得網路資源的流程。');
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: 'ENRICH_CAPTURE',
      model: 'qwen3:latest',
    });
  });

  it('still saves the raw note when enrichment fails', async () => {
    // Enrichment is best-effort by design: small models are unreliable at
    // structured output, and a capture must not be lost to that.
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: vi.fn().mockRejectedValue(new Error('no port')) },
    });

    const outcome = await captureNote(noteOf(), { ...CONFIG, enrich: true });

    expect(outcome).toEqual({ ok: true, method: 'obsidian' });
    expect(navigatedTo).toContain('content=');
  });

  it('caps how much text is sent for enrichment', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ result: null });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await captureNote(noteOf({ original: 'x'.repeat(9000) }), {
      ...CONFIG,
      enrich: true,
    });

    const sent = sendMessage.mock.calls[0]?.[0] as { text: string };
    expect(sent.text).toHaveLength(4000);
  });

  it('does not contact the background worker when enrichment is off', async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await captureNote(noteOf(), CONFIG);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
