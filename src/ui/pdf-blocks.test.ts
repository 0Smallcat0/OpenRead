// @vitest-environment jsdom
/**
 * Turning a PDF.js text layer back into paragraphs.
 *
 * The line breaks are given — PDF.js emits `<br>` between lines — so what is
 * tested here is the part that is a judgement call: where one paragraph ends.
 * jsdom returns a zero rect for everything, so the geometry is supplied, which
 * is the only way these rules are exercisable at all.
 */
import { describe, it, expect } from 'vitest';
import {
  collectPdfLines,
  groupIntoParagraphs,
  collectPdfParagraphs,
  type Box,
} from './pdf-blocks';

const LINE_HEIGHT = 12;

/** Build a text layer the way PDF.js does: spans, with `br` between lines. */
function layerOf(lines: { text: string; top: number; left?: number }[]): {
  layer: HTMLElement;
  rectOf: (element: HTMLElement) => Box;
} {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  const boxes = new Map<HTMLElement, Box>();

  lines.forEach((line, index) => {
    const span = document.createElement('span');
    span.textContent = line.text;
    const left = line.left ?? 50;
    boxes.set(span, {
      top: line.top,
      bottom: line.top + LINE_HEIGHT,
      left,
      right: left + 400,
      height: LINE_HEIGHT,
    });
    layer.appendChild(span);
    if (index < lines.length - 1) {
      layer.appendChild(document.createElement('br'));
    }
  });

  return {
    layer,
    rectOf: (element) =>
      boxes.get(element) ?? { top: 0, bottom: 0, left: 0, right: 0, height: 0 },
  };
}

/** Lines one after another with no unusual gap. */
function flowing(texts: string[], from = 0): { text: string; top: number }[] {
  return texts.map((text, i) => ({ text, top: from + i * (LINE_HEIGHT + 2) }));
}

describe('collectPdfLines', () => {
  it('reads the line breaks PDF.js already put there', () => {
    const { layer, rectOf } = layerOf(flowing(['First line.', 'Second line.']));
    const lines = collectPdfLines(layer, rectOf);
    expect(lines.map((line) => line.text)).toEqual([
      'First line.',
      'Second line.',
    ]);
  });

  it('joins the runs a single line is split into', () => {
    // One line is often several spans — a font change, a ligature, a number.
    const layer = document.createElement('div');
    for (const part of ['The trace ', 'compiler ', 'specializes']) {
      const span = document.createElement('span');
      span.textContent = part;
      layer.appendChild(span);
    }
    const lines = collectPdfLines(layer, () => ({
      top: 0,
      bottom: LINE_HEIGHT,
      left: 50,
      right: 450,
      height: LINE_HEIGHT,
    }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe('The trace compiler specializes');
  });

  it('drops the empty spans the viewer uses for positioning', () => {
    const { layer, rectOf } = layerOf(flowing(['Real text here.']));
    layer.appendChild(document.createElement('br'));
    layer.appendChild(document.createElement('span'));
    expect(collectPdfLines(layer, rectOf)).toHaveLength(1);
  });
});

describe('groupIntoParagraphs', () => {
  it('keeps a paragraph together across its lines', () => {
    // The whole point: a paragraph broken across lines by the layout is one
    // sentence to a translator, and handing it the breaks makes it translate a
    // column of fragments.
    const { layer, rectOf } = layerOf(
      flowing(['The trace compiler', 'specializes the code', 'at run time.']),
    );
    const paragraphs = collectPdfParagraphs(layer, rectOf);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.text).toBe(
      'The trace compiler specializes the code at run time.',
    );
  });

  it('splits where the pitch jumps past the page median', () => {
    const { layer, rectOf } = layerOf([
      ...flowing([
        'First paragraph line one.',
        'and line two.',
        'and line three.',
      ]),
      // Three lines of even pitch set the median; this one sits far past it.
      { text: 'A new paragraph starts.', top: 120 },
    ]);
    const paragraphs = collectPdfParagraphs(layer, rectOf);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]?.text).toBe('A new paragraph starts.');
  });

  it('splits at the second column of a two-column page', () => {
    // Left column runs down the page, then the right column starts again at
    // the top. Without this a paper reads as one paragraph per page.
    const { layer, rectOf } = layerOf([
      { text: 'Left column, first line.', top: 100, left: 50 },
      { text: 'Left column, second line.', top: 114, left: 50 },
      { text: 'Right column, first line.', top: 100, left: 500 },
    ]);
    const paragraphs = collectPdfParagraphs(layer, rectOf);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]?.text).toBe('Right column, first line.');
  });

  it('tolerates an indented first line', () => {
    // An indent is not a new column, and treating it as one splits every
    // paragraph in a book after its first line.
    const { layer, rectOf } = layerOf([
      { text: 'An indented opening line.', top: 100, left: 70 },
      { text: 'continuing at the margin.', top: 114, left: 50 },
    ]);
    expect(collectPdfParagraphs(layer, rectOf)).toHaveLength(1);
  });

  it('collapses the whitespace a layout leaves behind', () => {
    const { layer, rectOf } = layerOf([
      { text: '  Ragged   spacing ', top: 100 },
      { text: '   from   the layout.  ', top: 114 },
    ]);
    expect(collectPdfParagraphs(layer, rectOf)[0]?.text).toBe(
      'Ragged spacing from the layout.',
    );
  });

  it('has nothing to say about an empty layer', () => {
    expect(groupIntoParagraphs([])).toEqual([]);
    expect(collectPdfParagraphs(document.createElement('div'))).toEqual([]);
  });
});
