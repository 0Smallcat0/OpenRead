/**
 * Bilingual subtitles: the line that is playing, in the reader's language,
 * under the one the video is showing.
 *
 * The constraint that shapes everything here is that a caption is not a
 * paragraph. It is on screen for about two seconds, it is repainted far more
 * often than it changes, and there is no second chance — a translation that
 * arrives after the cue has gone is worse than none, because the reader is
 * already reading the next line. Whole-page translation can afford to queue
 * and to follow a reader's scroll; this cannot afford to queue at all.
 *
 * Which is exactly the shape Chrome's built-in translator fits: a segment
 * comes back in about 20 ms, measured over the benchmark fixtures, against a
 * cue's two seconds. The same feature on a cloud translator would be a round
 * trip per cue over the network for the length of a film.
 *
 * Two ways in, because sites do captions two ways:
 *
 *   TextTrack  a `<video>` with a `<track>`, which is the standard. The
 *              browser renders those cues into a shadow root nothing can
 *              reach, so the translation goes in an overlay positioned over
 *              the video.
 *   Rendered   a player that draws its own captions into ordinary elements —
 *              YouTube, and most large players. The translation is appended
 *              inside the player's own caption container, which means it
 *              inherits the position, the font and the fullscreen behaviour
 *              the player already worked out.
 */
import { CueCache, isTranslatableCue, normaliseCue } from '../core/cues';
import { toBcp47 } from '../core/bcp47';

export const SUBTITLE_CLASS = 'oit-subtitle';
const STYLE_ID = 'oit-subtitle-style';

/**
 * Players that draw their own captions, and where to put a translation.
 *
 * `container` is what to watch for changes; `line` is the element whose text
 * is the current cue. The translation is appended to the container, so it
 * moves, scales and goes fullscreen with the player's own caption without this
 * file knowing how any of that works.
 */
interface RenderedCaptions {
  container: string;
  line: string;
}

const RENDERED: RenderedCaptions[] = [
  // YouTube. The window container is repositioned by the player and survives
  // the segments being rebuilt, which is what makes it the right anchor.
  //
  // Checked against youtube.com on 2026-08-07 rather than taken from a blog
  // post: one container, two segments, carrying the caption text playing at
  // the time. That is a fact with an expiry date — a class rename ships this
  // feature doing nothing, silently — and it is the one thing the stress
  // harness cannot cover, since it drives a player-shaped fixture instead.
  {
    container: '.ytp-caption-window-container',
    line: '.ytp-caption-segment',
  },
];

export interface SubtitleDeps {
  /** Translate one cue. Rejects on failure; aborts on the signal. */
  translate: (text: string, signal: AbortSignal) => Promise<string>;
  targetLang: string;
  /**
   * Asked at mount and whenever the setting changes, not per cue.
   *
   * Per cue would put a `chrome.storage` read on the hot path of a feature
   * whose whole argument is that it is fast enough to keep up.
   */
  enabled: boolean;
  /**
   * Say something in the corner, once, when a video plays with no captions.
   *
   * The feature has one prerequisite it cannot satisfy itself: the player's
   * own captions have to be on. With them off there are no cues, so there is
   * nothing to translate and nothing appears — which is indistinguishable
   * from the feature being broken, and was reported as exactly that twice by
   * the same reader in one sitting.
   */
  notify?: (message: string) => void;
}

/** How long a video plays with no cue before that is worth mentioning. */
export const NO_CAPTIONS_AFTER_MS = 8000;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // Sized in `em` against whatever the player set, so the translation is a
  // second line of the same caption rather than a competing one. The shadow
  // rather than a background box: a box under a caption that already has one
  // reads as an error message.
  style.textContent = `
.${SUBTITLE_CLASS} {
  display: block;
  margin-top: 0.15em;
  font-size: 0.92em;
  line-height: 1.25;
  color: #ffe9a8;
  text-shadow:
    0 0 3px rgb(0 0 0 / 0.9),
    0 1px 2px rgb(0 0 0 / 0.9);
  white-space: pre-wrap;
  pointer-events: none;
}
.${SUBTITLE_CLASS}-overlay {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483000;
  max-width: 90%;
  text-align: center;
  font: 500 clamp(14px, 2.4vw, 28px)/1.3 system-ui, -apple-system, sans-serif;
  pointer-events: none;
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** The element a translation is written into, made once per caption host. */
function lineFor(host: HTMLElement, targetLang: string): HTMLElement {
  const existing = host.querySelector<HTMLElement>(`.${SUBTITLE_CLASS}`);
  if (existing) return existing;
  const line = host.ownerDocument.createElement('div');
  line.className = SUBTITLE_CLASS;
  const tag = toBcp47(targetLang);
  if (tag) line.lang = tag;
  line.setAttribute('dir', 'auto');
  host.appendChild(line);
  return line;
}

/**
 * One video's translation loop.
 *
 * Deliberately has no queue. If a cue changes while its predecessor is still
 * in flight, the predecessor is abandoned: it is about a line that is no
 * longer on screen, and showing it late under the current one would be worse
 * than showing nothing.
 */
class CueTranslator {
  private readonly cache = new CueCache();
  private controller: AbortController | null = null;
  private showing = '';

  constructor(
    private readonly deps: SubtitleDeps,
    private readonly write: (translation: string) => void,
  ) {}

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.showing = '';
    this.write('');
  }

  offer(raw: string): void {
    const cue = normaliseCue(raw);
    if (cue === this.showing) return;
    this.showing = cue;

    this.controller?.abort();
    this.controller = null;

    if (!cue || !isTranslatableCue(cue)) {
      this.write('');
      return;
    }

    const cached = this.cache.get(cue);
    if (cached !== undefined) {
      this.write(cached);
      return;
    }

    // Cleared rather than left showing the previous line: the old translation
    // under a new caption is a specific kind of wrong, where the reader has no
    // way to tell it is stale.
    this.write('');

    const controller = new AbortController();
    this.controller = controller;
    void this.deps
      .translate(cue, controller.signal)
      .then((translation) => {
        if (controller.signal.aborted) return;
        const trimmed = translation.trim();
        // Unchanged means the cue was already in the target language, and a
        // caption printed twice is worse than one printed once.
        if (!trimmed || trimmed === cue) return;
        this.cache.set(cue, trimmed);
        if (this.showing === cue) this.write(trimmed);
      })
      .catch(() => {
        // One cue of a film, and nothing useful to say about it in the two
        // seconds it would have been on screen for. But the cue must not stay
        // claimed: `showing` is what stops a repaint costing another round
        // trip, and leaving a failed cue in it means every repaint of that
        // caption is skipped too. Observed on YouTube — the service worker was
        // still starting when the first caption arrived, that one request
        // rejected, and the line then stayed blank for as long as the sentence
        // was on screen, coming right only when the speaker moved on.
        if (this.showing === cue) this.showing = '';
      });
  }
}

interface Attachment {
  disconnect: () => void;
}

/** A player that draws captions into the DOM: append inside its container. */
function attachRendered(
  container: HTMLElement,
  selector: string,
  deps: SubtitleDeps,
  onCue: () => void,
  onTranslation: () => void,
): Attachment {
  const doc = container.ownerDocument;
  ensureStyle(doc);
  const line = lineFor(container, deps.targetLang);

  const translator = new CueTranslator(deps, (translation) => {
    line.textContent = translation;
    if (translation) onTranslation();
  });

  const read = (): void => {
    const segments = Array.from(
      container.querySelectorAll<HTMLElement>(selector),
    );
    const cue = segments.map((s) => s.textContent ?? '').join(' ');
    if (isTranslatableCue(cue)) onCue();
    translator.offer(cue);
  };

  // The player rebuilds its segments rather than editing them, so childList
  // on the subtree is the event; characterData covers the players that do
  // edit in place.
  const observer = new doc.defaultView!.MutationObserver(() => {
    // Our own line is inside the container, so writing a translation would
    // otherwise re-enter this callback.
    read();
  });
  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  read();

  return {
    disconnect: () => {
      observer.disconnect();
      translator.stop();
      line.remove();
    },
  };
}

/** A `<video>` with a real text track: read `activeCues`, draw an overlay. */
function attachTextTrack(
  video: HTMLVideoElement,
  deps: SubtitleDeps,
  onCue: () => void,
  onTranslation: () => void,
): Attachment {
  const doc = video.ownerDocument;
  ensureStyle(doc);

  const overlay = doc.createElement('div');
  overlay.className = `${SUBTITLE_CLASS}-overlay`;
  const line = lineFor(overlay, deps.targetLang);

  /**
   * Re-parented on fullscreen, not just repositioned.
   *
   * In fullscreen the browser renders the fullscreen element's subtree and
   * nothing else, so an overlay left on `body` is invisible exactly when the
   * reader is most likely to be watching.
   */
  const place = (): void => {
    const host = doc.fullscreenElement ?? doc.body;
    if (overlay.parentElement !== host) host.appendChild(overlay);
    const box = video.getBoundingClientRect();
    const hostBox =
      host === doc.body
        ? { top: -window.scrollY, left: -window.scrollX }
        : host.getBoundingClientRect();
    overlay.style.top = `${String(box.bottom - hostBox.top - box.height * 0.22)}px`;
    overlay.style.left = `${String(box.left - hostBox.left + box.width / 2)}px`;
    overlay.style.width = `${String(box.width)}px`;
  };

  const translator = new CueTranslator(deps, (translation) => {
    line.textContent = translation;
    overlay.style.visibility = translation ? 'visible' : 'hidden';
    if (translation) {
      place();
      onTranslation();
    }
  });

  const read = (): void => {
    const texts: string[] = [];
    for (const track of Array.from(video.textTracks)) {
      if (track.mode === 'disabled') continue;
      for (const cue of Array.from(track.activeCues ?? [])) {
        const text = (cue as VTTCue).text;
        if (text) texts.push(text);
      }
    }
    const cue = texts.join(' ');
    if (isTranslatableCue(cue)) onCue();
    translator.offer(cue);
  };

  const tracks = Array.from(video.textTracks);
  for (const track of tracks) track.addEventListener('cuechange', read);
  // `addtrack` matters more than it looks: a player that fetches its captions
  // after the video element exists adds the track later, and without this the
  // feature works only for markup that shipped with the page.
  const onAddTrack = (event: Event): void => {
    const track = (event as TrackEvent).track;
    if (track && 'addEventListener' in track) {
      (track as TextTrack).addEventListener('cuechange', read);
    }
    read();
  };
  // Feature-detected, not assumed. `TextTrackList` is an EventTarget in a
  // browser and is not one everywhere — jsdom has no `addEventListener` on it
  // — and the throw does not stay local: it takes down the whole mount, so one
  // odd `<video>` on a page would silently cost that page every other kind of
  // subtitle translation too.
  const trackList = video.textTracks as unknown as Partial<EventTarget>;
  if (typeof trackList.addEventListener === 'function') {
    video.textTracks.addEventListener('addtrack', onAddTrack);
  }
  doc.addEventListener('fullscreenchange', place);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, { passive: true });
  place();
  read();

  return {
    disconnect: () => {
      for (const track of Array.from(video.textTracks)) {
        track.removeEventListener('cuechange', read);
      }
      if (typeof trackList.removeEventListener === 'function') {
        video.textTracks.removeEventListener('addtrack', onAddTrack);
      }
      doc.removeEventListener('fullscreenchange', place);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place);
      translator.stop();
      overlay.remove();
    },
  };
}

/**
 * Translate the subtitles of every video on this document.
 *
 * Returns a function that undoes it. Attaches to what is there now and to
 * whatever arrives later: a video page is nearly always a single-page app,
 * and the player is created after the navigation that asked for it.
 */
export function mountSubtitleTranslate(
  doc: Document,
  deps: SubtitleDeps,
): () => void {
  const attached = new Map<Element, Attachment>();

  const detach = (element: Element): void => {
    attached.get(element)?.disconnect();
    attached.delete(element);
  };

  const scan = (): void => {
    if (!deps.enabled) return;
    for (const { container, line } of RENDERED) {
      for (const host of Array.from(
        doc.querySelectorAll<HTMLElement>(container),
      )) {
        if (attached.has(host)) continue;
        attached.set(
          host,
          attachRendered(host, line, deps, seeCue, seeTranslation),
        );
      }
    }
    // A player that draws its own captions is already covered, and attaching
    // the overlay as well prints the line twice. The check has to run every
    // scan rather than once: YouTube builds its caption container *after* the
    // video element, so on page load there is no container, the overlay
    // attaches to the video, and the container arriving a moment later put a
    // second line on the screen. Measured on youtube.com: two `.oit-subtitle`
    // nodes for one video.
    const rendered = RENDERED.some(({ container }) =>
      doc.querySelector(container),
    );
    for (const video of Array.from(doc.querySelectorAll('video'))) {
      if (rendered) {
        detach(video);
        continue;
      }
      if (attached.has(video)) continue;
      attached.set(video, attachTextTrack(video, deps, seeCue, seeTranslation));
    }
    for (const element of Array.from(attached.keys())) {
      if (!element.isConnected) detach(element);
    }
  };

  // A video playing with nothing appearing has two different causes, and
  // telling a reader the wrong one is worse than telling them nothing.
  //
  // No cue at all: the player's captions are off, which is the prerequisite
  // this feature cannot satisfy for itself. A cue that produced no
  // translation: the captions are already in the language being translated
  // into — what a channel with its own Chinese subtitle track looks like to a
  // reader asking for Chinese, and the first version of this notice would
  // have told them to switch on captions that were already on.
  let sawCue = false;
  let sawTranslation = false;
  let told = false;
  const seeCue = (): void => {
    sawCue = true;
  };
  const seeTranslation = (): void => {
    sawCue = true;
    sawTranslation = true;
    // A translation appearing answers the question the notice asks, for good.
    // Without this, a video that translated fine for ten minutes and then hit
    // a stretch of silence would be told its captions are off.
    told = true;
  };
  const watchForSilence = (): void => {
    if (!deps.enabled || !deps.notify || told) return;
    const video = doc.querySelector('video');
    if (!video || video.paused) return;
    doc.defaultView?.setTimeout(() => {
      if (sawTranslation || told || !deps.enabled) return;
      told = true;
      deps.notify?.(
        sawCue
          ? `These captions are already in ${deps.targetLang}, so there is nothing to translate.`
          : 'OpenRead has nothing to translate here — turn the video’s own captions on (CC).',
      );
    }, NO_CAPTIONS_AFTER_MS);
  };

  const root = doc.documentElement ?? doc.body;
  const observer = new (doc.defaultView ?? window).MutationObserver(() => {
    scan();
  });
  if (root) observer.observe(root, { childList: true, subtree: true });
  scan();
  doc.addEventListener('play', watchForSilence, true);
  watchForSilence();

  return () => {
    observer.disconnect();
    doc.removeEventListener('play', watchForSilence, true);
    for (const element of Array.from(attached.keys())) detach(element);
  };
}
