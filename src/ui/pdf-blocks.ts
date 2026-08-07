/**
 * Turning a PDF.js text layer back into paragraphs.
 *
 * A web page hands you paragraphs; a PDF hands you glyph runs. PDF.js renders
 * the text layer as absolutely-positioned spans over the page canvas, one per
 * run, with `<br>` between lines — measured on the viewer's own sample paper:
 * 248 children on the first page, spans and `br` interleaved, each span
 * carrying `left`/`top` as percentages.
 *
 * So the line breaks are given and do not have to be inferred, which removes
 * the part of this that would have been guesswork. What is left is deciding
 * where one paragraph ends and the next begins, and that is geometry: a gap
 * taller than the text, or a jump to another column.
 *
 * Rects are injected rather than read, because jsdom returns zeros for every
 * one of them and a grouping rule that can only be exercised in a browser is a
 * rule nobody will change with confidence later.
 */

/** The shape of `getBoundingClientRect`, as much of it as this file needs. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

export interface PdfLine {
  spans: HTMLElement[];
  text: string;
  box: Box;
}

export interface PdfParagraph {
  lines: PdfLine[];
  text: string;
  /** The last line, which is what a translation is placed under. */
  end: PdfLine;
}

export type RectOf = (element: HTMLElement) => Box;

const defaultRect: RectOf = (element) => element.getBoundingClientRect();

/** Union of two boxes. */
function merge(a: Box, b: Box): Box {
  const top = Math.min(a.top, b.top);
  const bottom = Math.max(a.bottom, b.bottom);
  return {
    top,
    bottom,
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    height: bottom - top,
  };
}

/**
 * The lines of one text layer, in the order PDF.js emitted them.
 *
 * That order is the content stream's, which for an ordinary document is
 * reading order — including down one column and then down the next, which is
 * why two-column papers come out readable without any column detection here.
 */
export function collectPdfLines(
  layer: Element,
  rectOf: RectOf = defaultRect,
): PdfLine[] {
  const lines: PdfLine[] = [];
  let spans: HTMLElement[] = [];

  const flush = (): void => {
    if (spans.length === 0) return;
    const text = spans.map((span) => span.textContent ?? '').join('');
    if (text.trim()) {
      let box = rectOf(spans[0] as HTMLElement);
      for (const span of spans.slice(1)) box = merge(box, rectOf(span));
      lines.push({ spans, text, box });
    }
    spans = [];
  };

  for (const child of Array.from(layer.children)) {
    if (child.tagName === 'BR') {
      flush();
      continue;
    }
    // Anything else with text is part of the current line. PDF.js also emits
    // empty spans for positioning, which contribute nothing and are dropped by
    // the emptiness check in `flush`.
    if (child instanceof HTMLElement) spans.push(child);
  }
  flush();
  return lines;
}

/**
 * How much further apart than usual two lines must be to end a paragraph.
 *
 * Measured as line *pitch* — top to top — rather than the gap between boxes,
 * because the gap is not ours to trust. This extension pads every text-layer
 * span by 5px a side to make lines easier to grab, so on a real page the boxes
 * overlap and the measured gaps run negative: -8, -9, -2 down a column of
 * ordinary prose. Pitch is untouched by symmetric padding.
 *
 * Compared against the median pitch of the page rather than a fixed distance,
 * so it calibrates itself to the font size and the zoom instead of being right
 * at one of them. 1.5 sits between body prose, which is even, and the space
 * before a heading or a new paragraph, which on the viewer's own sample paper
 * jumped from a 25px pitch to 85px.
 */
export const PARAGRAPH_PITCH_RATIO = 1.5;

/**
 * Do two lines share any horizontal space at all?
 *
 * This replaces comparing left edges, which was wrong about the most visible
 * text on the page. A centred title moves its left edge by however much the
 * lines differ in width — measured on the viewer's sample paper, 157px to
 * 462px between the two lines of one title — so a left-edge rule split every
 * centred heading, author list and affiliation into fragments and translated
 * each one on its own. "Trace-based Just-in-Time Type Specialization for
 * Dynamic" and "Languages" are not two paragraphs.
 *
 * Overlap gets both cases right for the same reason: centred lines overlap
 * heavily however their edges move, and the second column of a two-column page
 * does not overlap the first at all.
 */
function overlaps(a: Box, b: Box): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
}

/** The typical top-to-top distance between lines, ignoring column breaks. */
function medianPitch(lines: PdfLine[]): number {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const step = (lines[i] as PdfLine).box.top - (lines[i - 1] as PdfLine).box.top;
    if (step > 0) pitches.push(step);
  }
  if (pitches.length === 0) return 0;
  pitches.sort((a, b) => a - b);
  return pitches[Math.floor(pitches.length / 2)] ?? 0;
}

/** Group lines into paragraphs by the geometry between them. */
export function groupIntoParagraphs(lines: PdfLine[]): PdfParagraph[] {
  const paragraphs: PdfParagraph[] = [];
  const pitch = medianPitch(lines);
  let current: PdfLine[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    // Joined with spaces rather than newlines: a paragraph broken across lines
    // by the layout is one sentence to a translator, and handing it the breaks
    // makes it translate a column of fragments.
    const text = current
      .map((line) => line.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const end = current[current.length - 1];
    if (text && end) paragraphs.push({ lines: current, text, end });
    current = [];
  };

  for (const line of lines) {
    const previous = current[current.length - 1];
    if (previous) {
      const step = line.box.top - previous.box.top;
      // Back up the page: the next column, or a footnote block.
      const newColumn = step < 0;
      const spaced = pitch > 0 && step > pitch * PARAGRAPH_PITCH_RATIO;
      if (newColumn || spaced || !overlaps(previous.box, line.box)) {
        flush();
      }
    }
    current.push(line);
  }
  flush();
  return paragraphs;
}

/** Both steps, which is how every caller wants it. */
export function collectPdfParagraphs(
  layer: Element,
  rectOf: RectOf = defaultRect,
): PdfParagraph[] {
  return groupIntoParagraphs(collectPdfLines(layer, rectOf));
}
