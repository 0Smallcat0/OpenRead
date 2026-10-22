// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  captionSize,
  mountSubtitles,
  SUBS_CLASS,
  SUBS_ON_CLASS,
  type SubtitleOptions,
} from './subtitles';
import type { CaptionTrack } from '../core/captions';

const TRACK: CaptionTrack = {
  videoId: 'abc',
  lang: 'en',
  generated: false,
  cues: [
    { start: 0, end: 2000, text: 'good morning' },
    { start: 2500, end: 5000, text: 'today we plant trees' },
    // Well past the read-ahead from the start of the video.
    { start: 200_000, end: 203_000, text: 'much later' },
  ],
};

let player: HTMLElement;
let video: HTMLVideoElement;
/** The video's clock, in seconds, as `currentTime` reports it. */
let now: number;

beforeEach(() => {
  document.body.innerHTML = `
    <div class="html5-video-player">
      <video class="html5-main-video"></video>
      <div class="ytp-caption-window-container"></div>
    </div>`;
  player = document.querySelector('.html5-video-player') as HTMLElement;
  video = document.querySelector('video') as HTMLVideoElement;
  now = 0.5;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => now,
  });
});

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function mount(overrides: Partial<SubtitleOptions> = {}) {
  const translate = vi.fn((text: string) => Promise.resolve(`譯：${text}`));
  const onGiveUp = vi.fn();
  const overlay = mountSubtitles({
    player,
    video,
    track: TRACK,
    displayMode: 'bilingual',
    translate,
    onGiveUp,
    ...overrides,
  });
  return { overlay, translate, onGiveUp };
}

const box = (): HTMLElement | null => player.querySelector(`.${SUBS_CLASS}`);
const visible = (selector: string): string | null => {
  const element = player.querySelector<HTMLElement>(selector);
  return element && !element.hidden ? element.textContent : null;
};

/** Move the clock and let the overlay see it, as playback would. */
function seek(seconds: number): void {
  now = seconds;
  video.dispatchEvent(new Event('timeupdate'));
}

describe('mountSubtitles', () => {
  it('replaces YouTube’s captions with the original, then its translation', async () => {
    mount();
    expect(player.classList.contains(SUBS_ON_CLASS)).toBe(true);
    // The line is up before its translation is back.
    expect(visible('.oit-subs-source')).toBe('good morning');
    expect(visible('.oit-subs-target')).toBeNull();

    await settle();
    expect(visible('.oit-subs-source')).toBe('good morning');
    expect(visible('.oit-subs-target')).toBe('譯：good morning');
  });

  it('translates what is coming up, not the whole track', async () => {
    const { translate } = mount();
    await settle();
    const asked = translate.mock.calls.map(([text]) => text);
    expect(asked).toEqual(['good morning', 'today we plant trees']);
  });

  it('follows the playhead, and shows nothing between lines', async () => {
    mount();
    await settle();
    seek(3);
    expect(visible('.oit-subs-target')).toBe('譯：today we plant trees');
    seek(2.2);
    expect(box()?.hidden).toBe(true);
  });

  it('reads further ahead as the video plays on', async () => {
    const { translate } = mount();
    await settle();
    seek(150);
    await settle();
    expect(translate.mock.calls.map(([text]) => text)).toContain('much later');
  });

  it('shows only the translation when asked to, and switches without a reload', async () => {
    const { overlay } = mount({ displayMode: 'translationOnly' });
    await settle();
    expect(visible('.oit-subs-source')).toBeNull();
    expect(visible('.oit-subs-target')).toBe('譯：good morning');

    overlay.setDisplayMode('bilingual');
    expect(visible('.oit-subs-source')).toBe('good morning');
  });

  it('shows a line once when the translation is the line itself', async () => {
    mount({
      displayMode: 'translationOnly',
      translate: (text) => Promise.resolve(text),
    });
    await settle();
    expect(visible('.oit-subs-source')).toBe('good morning');
    expect(visible('.oit-subs-target')).toBeNull();
  });

  it('shows nothing while an advert plays in the same video', async () => {
    mount();
    await settle();
    player.classList.add('ad-showing');
    seek(0.6);
    expect(box()?.hidden).toBe(true);
  });

  it('says when it is waiting for Chrome to download a model', async () => {
    let finish: (text: string) => void = () => undefined;
    mount({
      translate: (_text, _signal, onDownloadProgress) => {
        onDownloadProgress(0.4);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    expect(visible('.oit-subs-status')).toContain('40%');
    finish('早安');
    await settle();
    expect(visible('.oit-subs-status')).toBeNull();
  });

  it('shows a line that failed untranslated and carries on', async () => {
    mount({
      translate: (text) =>
        text === 'good morning'
          ? Promise.reject(new Error('one bad line'))
          : Promise.resolve(`譯：${text}`),
    });
    await settle();
    expect(visible('.oit-subs-source')).toBe('good morning');
    expect(visible('.oit-subs-target')).toBeNull();
    seek(3);
    expect(visible('.oit-subs-target')).toBe('譯：today we plant trees');
  });

  it('gives YouTube its captions back when translation keeps failing', async () => {
    const { onGiveUp } = mount({
      track: {
        ...TRACK,
        cues: [0, 1, 2, 3].map((n) => ({
          start: n * 1000,
          end: n * 1000 + 900,
          text: `line ${String(n)}`,
        })),
      },
      translate: () => Promise.reject(new Error('Ollama is not running.')),
    });
    await settle();
    await settle();
    expect(onGiveUp).toHaveBeenCalledWith('Ollama is not running.');
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(box()).toBeNull();
    expect(player.classList.contains(SUBS_ON_CLASS)).toBe(false);
  });

  it('stops cleanly, cancelling what is still being translated', () => {
    let signal: AbortSignal | undefined;
    const { overlay } = mount({
      translate: (_text, given) => {
        signal = given;
        return new Promise(() => undefined);
      },
    });
    overlay.stop();
    expect(signal?.aborted).toBe(true);
    expect(box()).toBeNull();
    expect(player.classList.contains(SUBS_ON_CLASS)).toBe(false);
    // YouTube's own window was hidden by the class, never touched.
    expect(
      player.querySelector('.ytp-caption-window-container'),
    ).not.toBeNull();
  });

  it('writes captions as text, never as markup', async () => {
    mount({
      track: {
        ...TRACK,
        cues: [{ start: 0, end: 2000, text: '<img src=x onerror=alert(1)>' }],
      },
      translate: () => Promise.resolve('<b>bold</b>'),
    });
    await settle();
    expect(player.querySelector('img')).toBeNull();
    expect(player.querySelector('b')).toBeNull();
    expect(visible('.oit-subs-target')).toBe('<b>bold</b>');
  });
});

describe('captionSize', () => {
  it('scales with the player, with a floor for the smallest ones', () => {
    expect(captionSize(360)).toBe(14);
    expect(captionSize(1080)).toBe(43);
    expect(captionSize(100)).toBe(13);
  });
});
