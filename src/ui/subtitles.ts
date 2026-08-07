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
  /**
   * Where the translation goes, which is not where the container is.
   *
   * The container spans the whole video and is only a positioning context;
   * the caption a reader sees lives in a box the player positions inside it.
   * Appending to the container put the translation at the top-left of the
   * frame at 10px, in the caption colour, over whatever the video was showing:
   * measured at y=70 while the caption itself was at y=590. The text was
   * right every time and nobody could see it, which is why this survived four
   * rounds of "it works" — every check read `textContent` and none read a
   * bounding box.
   *
   * Resolved on every write, because the player rebuilds this box.
   */
  anchor: string;
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
    anchor: '.caption-window',
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

/**
 * How long to wait before trying a failed cue again.
 *
 * Short, because a caption is on screen for a couple of seconds and a retry
 * that lands after it has gone is worth nothing. Once only: a cue that fails
 * twice is not going to work on the third attempt either, and a caption is not
 * worth spending a loop on.
 */
export const RETRY_AFTER_MS = 700;

/**
 * How long the previous translation stays up while the next one is fetched.
 *
 * Long enough that the common case never blanks — the built-in engine answers
 * a caption in tens of milliseconds — and short enough that one which really
 * is late does not sit under the wrong caption for a whole sentence.
 */
export const GRACE_MS = 400;

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
  text-align: center;
  font-size: 0.92em;
  line-height: 1.25;
  color: #ffe9a8;
  text-shadow:
    0 0 3px rgb(0 0 0 / 0.9),
    0 1px 2px rgb(0 0 0 / 0.9);
  white-space: pre-wrap;
  pointer-events: none;
}
/*
 * Inside a player's own caption box, the translation is taken out of flow and
 * drawn directly above the caption.
 *
 * Below is where it belongs, and below is where it cannot go. The player puts
 * that box close to the bottom edge and sizes it for the caption alone;
 * a line added under it is drawn off the picture — measured at y=687 against a
 * video ending at 663, over the control bar. Lifting the box back up with a
 * transform is the other way to fix that, and the player rewrites the box's
 * position constantly, so it shuddered.
 *
 * Out of flow, the box's own height never changes, so the player's layout is
 * left exactly as it was and there is nothing to fight over.
 */
.${SUBTITLE_CLASS}-inline {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-top: 0;
  margin-bottom: 0.15em;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: SubtitleDeps,
    private readonly write: (translation: string) => void,
  ) {}

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.clearTimers();
    this.showing = '';
    this.write('');
  }

  private clearTimers(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.grace !== null) clearTimeout(this.grace);
    this.timer = null;
    this.grace = null;
  }

  offer(raw: string, retried = false): void {
    const cue = normaliseCue(raw);
    if (cue === this.showing) return;
    this.showing = cue;

    this.controller?.abort();
    this.controller = null;
    this.clearTimers();

    if (!cue || !isTranslatableCue(cue)) {
      // Nothing is coming, so there is nothing to wait for: a sound marker or
      // a gap in the speech clears at once.
      this.write('');
      return;
    }

    const cached = this.cache.get(cue);
    if (cached !== undefined) {
      this.write(cached);
      return;
    }

    // Not cleared yet.
    //
    // Clearing here is honest — an old translation under a new caption is a
    // kind of wrong the reader cannot see — and it was also the flicker.
    // Sampled at 200 ms over twelve seconds of playback: 33 of 60 frames had
    // nothing on screen, one blank per caption change, and captions change
    // every second or two. Text, gone, text, gone.
    //
    // What the blank was protecting against lasts one round trip, which is
    // tens of milliseconds on the built-in engine. The blank lasted just as
    // long and was far easier to see. So the previous line stays up for a
    // grace period, and is cleared only if the next one really is late.
    this.grace = setTimeout(() => {
      if (this.showing === cue) this.write('');
    }, GRACE_MS);

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
        if (this.showing !== cue) return;
        this.clearTimers();
        this.write(trimmed);
      })
      .catch(() => {
        // Try once more, on a timer.
        //
        // The first version released the cue and waited for the next repaint,
        // on the assumption that a player rewrites its caption many times a
        // second. Measured on YouTube: zero mutations in twenty seconds while
        // one caption was on screen. There is no next repaint, so a released
        // cue was never offered again and the line stayed blank until the
        // speaker moved on.
        //
        // Which matters most for the first caption of a video, where the
        // failure is a cold service worker rather than anything about the
        // text — reported twice as the feature simply not working, on a page
        // where it then worked perfectly from the second sentence onward.
        if (this.showing !== cue || retried) return;
        this.timer = setTimeout(() => {
          if (this.showing === cue) {
            this.showing = '';
            this.offer(cue, true);
          }
        }, RETRY_AFTER_MS);
      });
  }
}

interface Attachment {
  disconnect: () => void;
}

/**
 * A player that draws its own captions: put the translation in the same box.
 *
 * Three shapes were tried and measured, and only this one holds still.
 *
 * Appended to the caption *container* — the element that spans the whole video
 * — the line landed at the top-left of the frame at 10px, because that
 * container is a positioning context and carries none of the caption's own
 * type. Correct text, invisible.
 *
 * Appended to the caption box with a `transform` to lift the box back into
 * frame, the player fought it: it rewrites that box's position constantly, so
 * the caption itself visibly shuddered.
 *
 * Drawn in an overlay of ours, positioned from the caption's rectangle on
 * every mutation, it flickered — a discrete jump per reposition — and drifted
 * over the control bar.
 *
 * So: appended to the caption box, and nothing else touched. Measured on
 * youtube.com that a node put there survives the caption changing and that the
 * box element is reused rather than rebuilt, which is what makes this stable:
 * the player lays the box out, and the translation is simply in it.
 */
function attachRendered(
  container: HTMLElement,
  { line: selector, anchor }: RenderedCaptions,
  deps: SubtitleDeps,
  onCue: () => void,
  onTranslation: () => void,
): Attachment {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  ensureStyle(doc);
  const line = lineFor(container, deps.targetLang);

  /**
   * Last child of the caption box, and sized like the caption.
   *
   * Idempotent on purpose: it runs on every write, and writing a style that is
   * already set is what a flicker is made of. Only the parent and the size are
   * touched, and only when they are wrong.
   */
  const place = (): void => {
    const host = container.querySelector<HTMLElement>(anchor) ?? container;
    if (line.parentElement !== host || line.nextElementSibling) {
      host.appendChild(line);
    }
    line.classList.add(`${SUBTITLE_CLASS}-inline`);

    // The box carries no font size — the segment inside it does — so reading
    // the box gave the player's chrome instead: 12px under a 40px caption in
    // fullscreen. Reading the segment also carries the reader's own
    // caption-size setting without this knowing the setting exists.
    const segment = container.querySelector<HTMLElement>(selector);
    if (!segment || !view) return;
    const size = Math.round(
      parseFloat(view.getComputedStyle(segment).fontSize) * 0.92,
    );
    const wanted = `${String(size)}px`;
    if (size > 0 && line.style.fontSize !== wanted)
      line.style.fontSize = wanted;
  };

  const translator = new CueTranslator(deps, (translation) => {
    if (translation) place();
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

  // The player rebuilds its caption lines rather than editing them, so
  // childList on the subtree is the event; characterData covers the players
  // that do edit in place.
  const observer = new view!.MutationObserver(() => {
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
    for (const shape of RENDERED) {
      for (const host of Array.from(
        doc.querySelectorAll<HTMLElement>(shape.container),
      )) {
        if (attached.has(host)) continue;
        attached.set(
          host,
          attachRendered(host, shape, deps, seeCue, seeTranslation),
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
