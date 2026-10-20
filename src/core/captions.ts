/**
 * A YouTube caption track, as the player fetched it, cut into sentences.
 *
 * The player asks `/api/timedtext` for the whole track at once, as `fmt=json3`,
 * and that response is read rather than fetched again: the request it answered
 * carries the proof-of-origin token YouTube now demands, and a request of our
 * own would have to forge one. Measured on 2026-10-21 on a desktop watch page:
 * one XHR per track, the full track in its body (2.2 MB of events for a
 * two-hour talk), re-requested whenever the reader picks another track.
 *
 * A track's events are the unit YouTube displays, which is not the unit worth
 * translating. Two shapes were seen, and they need opposite handling:
 *
 * - A human transcript: one event per line on screen, each a phrase, with
 *   sentences running across two or three of them and `\n` inside an event
 *   where the line wraps. Punctuated. Cut at the sentence's own full stop, so
 *   "in all of the presentations that we've had" is not translated without the
 *   clause that finishes it.
 * - Speech recognition (`kind=asr`): one event per rolling line, a timestamp per
 *   word, and no punctuation at all — not one mark in the first 400 events of
 *   the track measured. There is no full stop to cut at, so a sentence ends
 *   where the speaker paused, and a run with no pause is cut at a length a
 *   reader can take in at once.
 */

/** One stretch of speech, in milliseconds of video time. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionTrack {
  videoId: string;
  /**
   * The language the cues are written in. YouTube's own auto-translate names
   * it in `tlang`, and its output is what the reader sees, so that wins over
   * `lang`, the track it was translated from.
   */
  lang: string;
  /** Speech recognition rather than a transcript somebody wrote. */
  generated: boolean;
  cues: Cue[];
}

interface Segment {
  utf8?: unknown;
  tOffsetMs?: unknown;
}

interface TimedTextEvent {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  /** A line break appended to the previous event; no text of its own. */
  aAppend?: unknown;
  segs?: unknown;
}

/** One word of recognised speech, or one event of a transcript. */
interface Piece {
  text: string;
  start: number;
  end: number;
}

/**
 * The gap between two recognised words that ends a sentence, when the track
 * has no punctuation to say so.
 *
 * Read off the track measured: the speaker's breaths fell at 800-1,000 ms
 * between word starts ("hi everyone" · "so by now you have probably heard of
 * chat GPT" · "it has taken the world…"), and the words inside a phrase at
 * 80-400 ms.
 */
export const PAUSE_MS = 700;

/** Silence after a transcript line long enough that nothing should carry over it. */
const SILENCE_MS = 1500;

/**
 * Lengths in characters, per writing system.
 *
 * A soft limit ends a cue at the next comma; a hard one ends it anyway. Two
 * lines of a subtitle are about 80 Latin characters, and a CJK character is
 * about three of those to read.
 */
const SPACED = { min: 8, soft: 80, hard: 140 };
const UNSPACED = { min: 3, soft: 26, hard: 44 };

const TERMINAL = /[.!?。！？…‼⁇]["'”’」』）)\]]*$/u;
const SOFT_BREAK = /[,;:，、；：]["'”’]*$/u;
/** A sound described rather than spoken: (Laughter), [Music], ♪ … ♪. */
const SOUND_TAG = /^[[(（【♪].*[\])）】♪]$/u;

/** Languages written without spaces between words. */
export function isUnspaced(lang: string): boolean {
  return /^(zh|ja|th|lo|km|my|bo)(-|$)/i.test(lang);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Every word or line in the track, in time order, with when it is on screen. */
function piecesOf(events: TimedTextEvent[], unspaced: boolean): Piece[] {
  const pieces: Piece[] = [];
  for (const event of events as (TimedTextEvent | null)[]) {
    if (!event || event.aAppend || !Array.isArray(event.segs)) continue;
    const start = numberOr(event.tStartMs, 0);
    const end = start + numberOr(event.dDurationMs, 0);
    const segs = (event.segs as (Segment | null)[]).filter(
      (seg): seg is Segment => typeof seg?.utf8 === 'string',
    );
    segs.forEach((seg, index) => {
      const text = (seg.utf8 as string).replace(/\n/g, unspaced ? '' : ' ');
      if (!text.trim()) return;
      const next = segs[index + 1];
      pieces.push({
        text,
        start: start + numberOr(seg.tOffsetMs, 0),
        end: next ? start + numberOr(next.tOffsetMs, 0) : end,
      });
    });
  }
  return pieces.sort((a, b) => a.start - b.start);
}

function joined(acc: string, next: string, unspaced: boolean): string {
  if (!acc) return next;
  if (unspaced || /\s$/.test(acc) || /^\s/.test(next)) return acc + next;
  return `${acc} ${next}`;
}

/**
 * One space between words, and none before a comma or full stop.
 *
 * Recognised tracks that punctuate send the mark as a word of its own — " ."
 * after "zusammen" in the German track measured — so joining words leaves
 * "Hallo zusammen ." on screen. Only `,` and `.`: French puts a space before
 * `!`, `?`, `:` and `;`, and taking it out would be correcting the language.
 */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ ([,.])(?=\s|$)/g, '$1')
    .trim();
}

/**
 * Cut a track's pieces into cues.
 *
 * Exported for the tests, which hand it events of each shape directly.
 */
export function toCues(events: TimedTextEvent[], lang: string): Cue[] {
  const unspaced = isUnspaced(lang);
  const limits = unspaced ? UNSPACED : SPACED;
  const pieces = piecesOf(events, unspaced);
  // Punctuated, if at least one piece in fifty ends a sentence. A recognised
  // track that punctuates does so every dozen words or so; one that does not
  // has none, so the threshold only has to tell zero from some.
  const terminals = pieces.filter((piece) =>
    TERMINAL.test(piece.text.trim()),
  ).length;
  const punctuated = terminals * 50 >= pieces.length;

  const cues: Cue[] = [];
  let text = '';
  let start = 0;
  let end = 0;
  const flush = (): void => {
    const cleaned = tidy(text);
    if (cleaned) cues.push({ start, end, text: cleaned });
    text = '';
  };

  pieces.forEach((piece, index) => {
    const own = piece.text.trim();
    if (SOUND_TAG.test(own)) {
      flush();
      cues.push({ start: piece.start, end: piece.end, text: own });
      return;
    }
    if (!text) {
      start = piece.start;
      end = piece.end;
    }
    text = joined(text, text ? piece.text : piece.text.trimStart(), unspaced);
    end = Math.max(end, piece.end);

    const next = pieces[index + 1];
    const length = tidy(text).length;
    const cut =
      !next ||
      length >= limits.hard ||
      (punctuated
        ? TERMINAL.test(own) ||
          (length >= limits.soft && SOFT_BREAK.test(own)) ||
          next.start - piece.end >= SILENCE_MS
        : length >= limits.min && next.start - piece.start >= PAUSE_MS);
    if (cut) flush();
  });
  return cues;
}

/**
 * The track in one `/api/timedtext` response, or null for anything else.
 *
 * Null rather than a throw: the response is somebody else's format, read off
 * somebody else's page, and a shape this does not know is a reason to leave
 * YouTube's own captions alone — never one to break the page.
 */
export function parseTrack(url: string, body: string): CaptionTrack | null {
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return null;
  }
  if (!address.pathname.endsWith('/api/timedtext')) return null;
  const videoId = address.searchParams.get('v');
  const lang =
    address.searchParams.get('tlang') ?? address.searchParams.get('lang');
  if (!videoId || !lang) return null;

  let events: unknown;
  try {
    events = (JSON.parse(body) as { events?: unknown }).events;
  } catch {
    return null;
  }
  if (!Array.isArray(events)) return null;
  const cues = toCues(events as TimedTextEvent[], lang);
  if (cues.length === 0) return null;
  return {
    videoId,
    lang,
    generated: address.searchParams.get('kind') === 'asr',
    cues,
  };
}

/** The latest cue to have started by `time`, or -1 before the first. */
export function lastStarted(cues: readonly Cue[], time: number): number {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((cues[middle] as Cue).start <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * The cue on screen at `time`, or -1 between cues.
 *
 * The latest one to have started, because recognised lines overlap: each
 * event stays up until the next line has scrolled in under it.
 */
export function cueAt(cues: readonly Cue[], time: number): number {
  const found = lastStarted(cues, time);
  if (found === -1) return -1;
  return time < (cues[found] as Cue).end ? found : -1;
}

/**
 * The video a YouTube address plays, or null for a page that plays none.
 *
 * The check that a track belongs to what is on screen. The home page plays
 * muted previews with captions of their own, and a track fetched for one of
 * those must not be laid over the video the reader opened afterwards.
 */
export function videoIdOf(href: string): string | null {
  let address: URL;
  try {
    address = new URL(href);
  } catch {
    return null;
  }
  if (address.pathname === '/watch') return address.searchParams.get('v');
  const match = /^\/(?:embed|shorts|live)\/([\w-]+)/.exec(address.pathname);
  return match?.[1] ?? null;
}

/**
 * Whether captions in `trackLang` are worth replacing for a reader of
 * `targetTag`.
 *
 * Not when they are already in the reader's language, judged by the language
 * and not the region or script: YouTube's own translation into Chinese, or a
 * British track for an American reader, is the reader's language already.
 * A target with no code is translated, since there is no telling.
 */
export function replacesCaptions(
  trackLang: string,
  targetTag: string | null,
): boolean {
  if (!targetTag) return true;
  const base = (tag: string): string => tag.split('-')[0]?.toLowerCase() ?? '';
  return base(trackLang) !== base(targetTag);
}
