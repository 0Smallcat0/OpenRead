// @vitest-environment jsdom
/**
 * The rendered-captions path, which is the one every large player uses.
 *
 * The TextTrack path needs a media element that actually fires `cuechange`,
 * which jsdom has no implementation of — that half is covered end to end in a
 * real browser instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountSubtitleTranslate, SUBTITLE_CLASS } from './subtitles';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function player(text: string): HTMLElement {
  document.body.innerHTML = `
    <div class="ytp-caption-window-container">
      <span class="ytp-caption-segment">${text}</span>
    </div>`;
  return document.querySelector<HTMLElement>('.ytp-caption-window-container')!;
}

const line = (): string =>
  document.querySelector(`.${SUBTITLE_CLASS}`)?.textContent ?? '';

const segment = (): HTMLElement =>
  document.querySelector<HTMLElement>('.ytp-caption-segment')!;

let translate: ReturnType<typeof vi.fn>;

const deps = (over: Record<string, unknown> = {}) => ({
  translate: translate as unknown as (
    text: string,
    signal: AbortSignal,
  ) => Promise<string>,
  targetLang: 'Traditional Chinese',
  enabled: true,
  ...over,
});

/**
 * Mount, and remember how to undo it.
 *
 * Not optional bookkeeping: the observer is attached to `documentElement`,
 * which jsdom keeps between tests, so a mount left running attaches itself to
 * the *next* test's player and writes translations from the previous test's
 * stub. Five assertions failed that way before this existed, all of them
 * reporting text no line of their own test had asked for.
 */
const mounts: Array<() => void> = [];
const mount = (over: Record<string, unknown> = {}): (() => void) => {
  const stop = mountSubtitleTranslate(document, deps(over));
  mounts.push(stop);
  return stop;
};

beforeEach(() => {
  document.body.innerHTML = '';
  translate = vi.fn((text: string) => Promise.resolve(`[${text}]`));
});

afterEach(() => {
  for (const stop of mounts.splice(0)) stop();
});

describe('mountSubtitleTranslate', () => {
  it('puts a translation under the caption that is showing', async () => {
    player('And then it worked.');
    mount();
    await flush();

    expect(translate).toHaveBeenCalledWith(
      'And then it worked.',
      expect.anything(),
    );
    expect(line()).toBe('[And then it worked.]');
  });

  it('marks the translation with the target language', async () => {
    player('And then it worked.');
    mount();
    await flush();
    expect(
      document.querySelector(`.${SUBTITLE_CLASS}`)?.getAttribute('lang'),
    ).toBe('zh-Hant');
  });

  it('follows the caption as the video plays', async () => {
    player('First line of the film.');
    mount();
    await flush();
    expect(line()).toBe('[First line of the film.]');

    segment().textContent = 'Second line of the film.';
    await flush();
    expect(line()).toBe('[Second line of the film.]');
  });

  it('does not translate the same line twice', async () => {
    player('A repeated line.');
    mount();
    await flush();

    segment().textContent = 'Something else entirely.';
    await flush();
    segment().textContent = 'A repeated line.';
    await flush();

    expect(translate).toHaveBeenCalledTimes(2);
    expect(line()).toBe('[A repeated line.]');
  });

  it('does not re-translate a repaint of the same line', async () => {
    // A player repositions its caption window constantly and rebuilds the
    // segments while doing it. Without this the feature costs a round trip a
    // frame to show the text already on screen.
    player('One line, painted twice.');
    mount();
    await flush();

    const container = document.querySelector('.ytp-caption-window-container')!;
    const fresh = document.createElement('span');
    fresh.className = 'ytp-caption-segment';
    fresh.textContent = 'One line,  painted   twice.';
    segment().replaceWith(fresh);
    await flush();

    expect(translate).toHaveBeenCalledTimes(1);
    expect(container.querySelector(`.${SUBTITLE_CLASS}`)?.textContent).toBe(
      '[One line, painted twice.]',
    );
  });

  it('leaves a sound marker alone', async () => {
    player('[Music]');
    mount();
    await flush();

    expect(translate).not.toHaveBeenCalled();
    expect(line()).toBe('');
  });

  it('clears the old translation the moment the caption changes', async () => {
    let release: (value: string) => void = () => undefined;
    translate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    player('First line.');
    mount();
    await flush();
    release('第一行');
    await flush();
    expect(line()).toBe('第一行');

    segment().textContent = 'Second line, still translating.';
    await flush();
    // Not the previous translation: an old caption under a new line is wrong
    // in a way the reader cannot see is wrong.
    expect(line()).toBe('');
  });

  it('throws away a translation that arrives after its cue has gone', async () => {
    const pending: Array<(value: string) => void> = [];
    translate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pending.push(resolve);
        }),
    );
    player('First line.');
    mount();
    await flush();

    segment().textContent = 'Second line.';
    await flush();

    // The first cue answers now, two seconds late and about a line that has
    // already gone.
    pending[0]?.('第一行');
    await flush();
    expect(line()).toBe('');

    pending[1]?.('第二行');
    await flush();
    expect(line()).toBe('第二行');
  });

  it('says nothing when the engine hands the cue back unchanged', async () => {
    translate = vi.fn((text: string) => Promise.resolve(text));
    player('Already in the target language.');
    mount();
    await flush();
    expect(line()).toBe('');
  });

  it('survives a failed translation without breaking the next cue', async () => {
    translate = vi.fn((text: string) =>
      text.startsWith('First')
        ? Promise.reject(new Error('nope'))
        : Promise.resolve(`[${text}]`),
    );
    player('First line.');
    mount();
    await flush();
    expect(line()).toBe('');

    segment().textContent = 'Second line.';
    await flush();
    expect(line()).toBe('[Second line.]');
  });

  it('does nothing at all when it is switched off', async () => {
    player('And then it worked.');
    mount({ enabled: false });
    await flush();

    expect(translate).not.toHaveBeenCalled();
    expect(document.querySelector(`.${SUBTITLE_CLASS}`)).toBeNull();
  });

  it('says why nothing happened when a video plays with no captions', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { value: false });
    mount({ notify: (m: string) => said.push(m) });
    video.dispatchEvent(new Event('play', { bubbles: true }));
    vi.advanceTimersByTime(9000);
    vi.useRealTimers();

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('captions');
  });

  it('says nothing when the captions are on', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    document.body.innerHTML =
      '<video id="v"></video><div class="ytp-caption-window-container">' +
      '<span class="ytp-caption-segment">A line of speech.</span></div>';
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { value: false });
    mount({ notify: (m: string) => said.push(m) });
    video.dispatchEvent(new Event('play', { bubbles: true }));
    // The translation has to land before the timer is allowed to fire: what
    // silences the notice is a translation appearing on screen, not a cue
    // existing. YouTube exposes a text track even with its captions switched
    // off, so "we saw a cue" said nothing about what the reader could see.
    await flush();
    vi.advanceTimersByTime(9000);
    vi.useRealTimers();

    expect(said).toEqual([]);
  });

  it('says the captions are already in the target, not to switch them on', async () => {
    // A channel with its own Chinese subtitle track, read by someone asking
    // for Chinese: the captions are on, there is a cue, and the engine hands
    // it straight back. Telling that reader to turn on captions would be
    // advice about something they had already done.
    vi.useFakeTimers();
    const said: string[] = [];
    translate = vi.fn((text: string) => Promise.resolve(text));
    document.body.innerHTML =
      '<video id="v"></video><div class="ytp-caption-window-container">' +
      '<span class="ytp-caption-segment">這是一句已經是中文的字幕。</span></div>';
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { value: false });
    mount({ notify: (m: string) => said.push(m) });
    video.dispatchEvent(new Event('play', { bubbles: true }));
    await flush();
    vi.advanceTimersByTime(9000);
    vi.useRealTimers();

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('already in Traditional Chinese');
    expect(said[0]).not.toContain('CC');
  });

  it('says it once, not once a play event', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    document.body.innerHTML = '<video id="v"></video>';
    const video = document.getElementById('v') as HTMLVideoElement;
    Object.defineProperty(video, 'paused', { value: false });
    mount({ notify: (m: string) => said.push(m) });
    for (let i = 0; i < 5; i++) {
      video.dispatchEvent(new Event('play', { bubbles: true }));
    }
    vi.advanceTimersByTime(20000);
    vi.useRealTimers();

    expect(said).toHaveLength(1);
  });

  it('takes its line back when unmounted', async () => {
    player('And then it worked.');
    const stop = mount();
    await flush();
    expect(document.querySelector(`.${SUBTITLE_CLASS}`)).not.toBeNull();

    stop();
    expect(document.querySelector(`.${SUBTITLE_CLASS}`)).toBeNull();
  });

  it('attaches to a player that arrives after the navigation', async () => {
    // Every video site is a single-page app, and the player is built after the
    // route change that asked for it.
    mount();
    await flush();
    expect(translate).not.toHaveBeenCalled();

    player('A player that showed up late.');
    await flush();
    expect(line()).toBe('[A player that showed up late.]');
  });
});
