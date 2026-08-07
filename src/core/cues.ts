/**
 * Subtitle cues: what counts as a new one, and not translating it twice.
 *
 * A caption is not a paragraph. It arrives two seconds at a time, it is
 * repainted far more often than it changes — a player repositions its caption
 * window on every resize and some rewrite the same text on every frame — and
 * the same line comes back verbatim later in the same video. Sending each
 * repaint to a translator would spend a round trip per frame to produce the
 * text already on screen.
 *
 * So the decisions that matter are "is this actually different from what is
 * showing" and "have we translated this before", and both are string work with
 * no DOM in them.
 */

/**
 * One cue's text, in a form two repaints of the same caption agree on.
 *
 * Players split a caption across several spans and rebuild them constantly,
 * so the joined text arrives with whatever whitespace the split produced.
 * Without this, `Hello  there` and `Hello there` are two cues and both get
 * translated.
 */
export function normaliseCue(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a cue is worth translating at all.
 *
 * Music and sound-effect markers — `[Music]`, `♪♪`, `(applause)` — are the
 * commonest thing an auto-caption track contains between sentences, and a
 * translator asked for them returns something confidently wrong.
 */
export function isTranslatableCue(text: string): boolean {
  const cue = normaliseCue(text);
  if (cue.length < 2) return false;
  // Wholly bracketed or wholly musical: `[Music]`, `(applause)`, `♪ ♪`.
  if (/^[[(][^\])]*[\])]$/.test(cue)) return false;
  if (/^[\s♪♫»-]+$/.test(cue)) return false;
  // Needs a letter somewhere. A cue of digits and punctuation is a timestamp
  // or a score line, and comes back unchanged at best.
  return /\p{L}/u.test(cue);
}

/**
 * Translations already seen, newest kept.
 *
 * A video repeats lines — a chorus, a catchphrase, a speaker's name — and a
 * player repaints far more often than it changes text. Bounded because a
 * three-hour stream would otherwise hold every line it ever showed.
 */
export class CueCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly limit = 500) {}

  get(text: string): string | undefined {
    const key = normaliseCue(text);
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // Re-inserted so the lines a video keeps using stay, and the ones it said
    // once fall off the end.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(text: string, translation: string): void {
    const key = normaliseCue(text);
    this.entries.delete(key);
    this.entries.set(key, translation);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
