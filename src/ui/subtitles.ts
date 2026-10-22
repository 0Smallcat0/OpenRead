/**
 * A video's captions, original and translation, laid over its YouTube player.
 *
 * YouTube's own caption window is hidden rather than written into. The player
 * redraws it from its own track every time a line changes, so a translation
 * inserted there lasts until the next word arrives; an element of our own,
 * inside the player so that it follows it into fullscreen, is redrawn only
 * when we say.
 *
 * Translation runs a little ahead of the playhead rather than over the whole
 * track. A two-hour talk is two thousand cues, and a reader on their own API
 * key who watches ten minutes of it should pay for ten minutes.
 */
import {
  cueAt,
  lastStarted,
  type CaptionTrack,
  type Cue,
} from '../core/captions';
import type { DisplayMode } from '../settings';

const STYLE_ID = 'oit-subs-style';
export const SUBS_CLASS = 'oit-subs';
/** On the player while ours are up. It is what hides YouTube's. */
export const SUBS_ON_CLASS = 'oit-subs-on';

/** Two in flight, for the reasons `fullpage.ts` gives at its CONCURRENCY. */
const CONCURRENCY = 2;

/**
 * How far past the playhead to have translated.
 *
 * Ninety seconds is thirty-odd cues: on Chrome's own translator that is under
 * a second of work, and on a local model at half a second a cue it still stays
 * ahead of someone watching at double speed.
 */
const LOOKAHEAD_MS = 90_000;

/**
 * Failures in a row before YouTube gets its captions back.
 *
 * One bad cue is shown untranslated and forgotten. Three in a row is an engine
 * that is not answering, and a reader is better served by the captions they
 * turned on than by an overlay that would show the same lines with nothing
 * under them.
 */
const GIVE_UP_AFTER = 3;

export interface SubtitleOptions {
  /** The `.html5-video-player` the video plays in. */
  player: HTMLElement;
  video: HTMLVideoElement;
  track: CaptionTrack;
  displayMode: DisplayMode;
  translate: (
    text: string,
    signal: AbortSignal,
    onDownloadProgress: (loaded: number) => void,
  ) => Promise<string>;
  /** Translation kept failing; the overlay has already taken itself down. */
  onGiveUp: (reason: string) => void;
}

export interface SubtitleOverlay {
  setDisplayMode: (mode: DisplayMode) => void;
  /** Take the overlay down and give YouTube its captions back. */
  stop: () => void;
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // Dark boxes and white text, as YouTube's own are: a caption sits over
  // pictures of any colour, and nothing else is readable over all of them.
  // Higher up while the controls are showing, which is what YouTube does too,
  // or the progress bar would sit on top of the line being read.
  style.textContent = `
.${SUBS_ON_CLASS} .ytp-caption-window-container {
  display: none !important;
}
.${SUBS_CLASS} {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 64px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15em;
  pointer-events: none;
  text-align: center;
  line-height: 1.3;
  font-family: "YouTube Noto", Roboto, Arial, sans-serif;
}
.ytp-autohide .${SUBS_CLASS} {
  bottom: 3%;
}
.${SUBS_CLASS}[hidden],
.${SUBS_CLASS} [hidden] {
  display: none;
}
.${SUBS_CLASS} > span {
  max-width: 86%;
  padding: 0.05em 0.4em;
  color: #fff;
  background: rgba(8, 8, 8, 0.75);
  border-radius: 0.15em;
  white-space: pre-wrap;
}
.${SUBS_CLASS} .oit-subs-source {
  font-size: 0.85em;
}
.${SUBS_CLASS} .oit-subs-status {
  font-size: 0.7em;
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * Caption size for a player this tall.
 *
 * Four percent of the height, which is about what YouTube's own come to at
 * its default size: 14 px in the small embedded player, 43 px in fullscreen.
 */
export function captionSize(playerHeight: number): number {
  return Math.max(13, Math.round(playerHeight * 0.04));
}

export function mountSubtitles(options: SubtitleOptions): SubtitleOverlay {
  const { player, video, track } = options;
  const doc = player.ownerDocument;
  const cues: readonly Cue[] = track.cues;
  let mode = options.displayMode;

  ensureStyle(doc);
  const box = doc.createElement('div');
  box.className = SUBS_CLASS;
  box.hidden = true;
  const source = doc.createElement('span');
  source.className = 'oit-subs-source';
  // The video's language, so a screen reader and the font fallback both know.
  source.lang = track.lang;
  const target = doc.createElement('span');
  target.className = 'oit-subs-target';
  const status = doc.createElement('span');
  status.className = 'oit-subs-status';
  status.hidden = true;
  box.append(source, target, status);
  player.appendChild(box);
  player.classList.add(SUBS_ON_CLASS);

  const sizeTo = (height: number): void => {
    box.style.fontSize = `${String(captionSize(height))}px`;
  };
  sizeTo(player.clientHeight);
  const view = doc.defaultView;
  const resize =
    view && 'ResizeObserver' in view
      ? new view.ResizeObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (entry) sizeTo(entry.contentRect.height);
        })
      : null;
  resize?.observe(player);

  /** Index → translation; null for a cue that failed, shown untranslated. */
  const translations = new Map<number, string | null>();
  const pending = new Set<number>();
  const controller = new AbortController();
  let stopped = false;
  let failures = 0;
  /** Where read-ahead starts: the latest cue to have begun. */
  let cursor = 0;
  /** Chrome fetching a language pack for this pair, 0-1, or null. */
  let downloading: number | null = null;

  /** What is on screen, so a frame that changes nothing touches nothing. */
  let shown = '';

  const draw = (): void => {
    // An advert plays in the same <video>, with a clock of its own; the
    // video's captions at the advert's timestamps would be someone else's
    // words over someone else's pictures.
    const index = player.classList.contains('ad-showing')
      ? -1
      : cueAt(cues, video.currentTime * 1000);
    const cue = index === -1 ? undefined : cues[index];
    const translation = index === -1 ? undefined : translations.get(index);
    // The translation only when there is one worth showing: not yet, failed,
    // or identical to the line it came from all leave the original alone.
    const line =
      cue !== undefined &&
      typeof translation === 'string' &&
      translation !== '' &&
      translation !== cue.text
        ? translation
        : null;
    const percent = downloading === null ? null : Math.round(downloading * 100);

    const next = JSON.stringify([index, line, mode, percent]);
    if (next === shown) return;
    shown = next;

    status.hidden = percent === null;
    status.textContent =
      percent === null
        ? ''
        : percent > 0
          ? `OpenRead: downloading the translation model, ${String(percent)}%`
          : 'OpenRead: downloading the translation model';

    source.textContent = cue?.text ?? '';
    source.hidden = !cue || (line !== null && mode === 'translationOnly');
    target.textContent = line ?? '';
    target.hidden = line === null;
    box.hidden = !cue && percent === null;
  };

  const giveUp = (reason: string): void => {
    stop();
    options.onGiveUp(reason);
  };

  const pump = (): void => {
    if (stopped) return;
    const horizon = video.currentTime * 1000 + LOOKAHEAD_MS;
    for (
      let index = cursor;
      index < cues.length && pending.size < CONCURRENCY;
      index++
    ) {
      const cue = cues[index] as Cue;
      if (cue.start > horizon) break;
      if (translations.has(index) || pending.has(index)) continue;
      pending.add(index);
      options
        .translate(cue.text, controller.signal, (loaded) => {
          if (stopped) return;
          downloading = loaded;
          draw();
        })
        .then(
          (text) => {
            failures = 0;
            downloading = null;
            translations.set(index, text.trim());
          },
          (error: unknown) => {
            if (stopped) return;
            translations.set(index, null);
            failures += 1;
            if (failures >= GIVE_UP_AFTER) {
              giveUp(error instanceof Error ? error.message : String(error));
            }
          },
        )
        .finally(() => {
          pending.delete(index);
          if (stopped) return;
          draw();
          pump();
        });
    }
  };

  /** Draw, and move read-ahead along with the playhead. */
  const tick = (): void => {
    if (stopped) return;
    draw();
    const from = Math.max(0, lastStarted(cues, video.currentTime * 1000));
    if (from !== cursor) {
      cursor = from;
      pump();
    }
  };

  // Every frame while playing, because a line that appears a quarter of a
  // second after it is spoken reads as out of sync; `timeupdate` alone fires
  // only four times a second. Nothing at all while paused.
  let frame = 0;
  const loop = (): void => {
    tick();
    frame = view?.requestAnimationFrame(loop) ?? 0;
  };
  const play = (): void => {
    if (frame === 0 && view && 'requestAnimationFrame' in view) {
      frame = view.requestAnimationFrame(loop);
    }
  };
  const halt = (): void => {
    if (frame !== 0) view?.cancelAnimationFrame(frame);
    frame = 0;
    tick();
  };
  const listeners: [string, () => void][] = [
    ['playing', play],
    ['pause', halt],
    ['ended', halt],
    ['seeked', tick],
    ['timeupdate', tick],
  ];
  for (const [event, listener] of listeners) {
    video.addEventListener(event, listener);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (frame !== 0) view?.cancelAnimationFrame(frame);
    for (const [event, listener] of listeners) {
      video.removeEventListener(event, listener);
    }
    resize?.disconnect();
    box.remove();
    player.classList.remove(SUBS_ON_CLASS);
  }

  cursor = Math.max(0, lastStarted(cues, video.currentTime * 1000));
  draw();
  pump();
  if (!video.paused) play();

  return {
    setDisplayMode: (next) => {
      mode = next;
      draw();
    },
    stop,
  };
}
