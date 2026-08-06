// @vitest-environment jsdom
/**
 * Pointing at a paragraph with a key held. The properties worth pinning are
 * about restraint: it must not fire without the key, must not fire twice on the
 * same block, and must never offer a form field or one of our own insertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountHoverTranslate, HOVER_CLASS, type HoverKey } from './hover';
import { TRANSLATED_ATTR } from './blocks';

const PAGE = `
  <p id="a">The first paragraph of the article body.</p>
  <p id="b">The second paragraph of the article body.</p>
  <textarea id="notes">Something the reader is typing.</textarea>
`;

let unmount: (() => void) | null = null;
let asked: HTMLElement[] = [];
let key: HoverKey = 'alt';
/** What `elementFromPoint` should answer next. jsdom has no hit testing. */
let under: Element | null = null;
/** Held open, so a test can look at the page mid-translation. */
let release: (() => void)[] = [];

function mount(): void {
  unmount = mountHoverTranslate(document, {
    getKey: () => Promise.resolve(key),
    translateBlock: (block) => {
      asked.push(block);
      return new Promise<boolean>((resolve) => {
        release.push(() => {
          resolve(true);
        });
      });
    },
  });
}

/** Let every held translation finish. */
async function finish(): Promise<void> {
  for (const settle of release.splice(0)) settle();
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** One pointer move, with whichever modifiers are named. */
async function point(
  target: Element | null,
  modifiers: Partial<MouseEventInit> = { altKey: true },
): Promise<void> {
  under = target;
  document.dispatchEvent(
    new MouseEvent('mousemove', { clientX: 10, clientY: 10, ...modifiers }),
  );
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
  asked = [];
  release = [];
  key = 'alt';
  under = null;
  document.elementFromPoint = () => under;
  mount();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.restoreAllMocks();
});

describe('mountHoverTranslate', () => {
  it('translates the paragraph being pointed at', async () => {
    await point(document.getElementById('a'));
    expect(asked.map((block) => block.id)).toEqual(['a']);
  });

  it('does nothing without the key', async () => {
    // A paragraph that translates itself because the mouse passed over it on
    // the way to a link is a page that fights back.
    await point(document.getElementById('a'), {});
    expect(asked).toEqual([]);
    expect(document.querySelectorAll(`.${HOVER_CLASS}`)).toHaveLength(0);
  });

  it('does nothing at all when it is turned off', async () => {
    key = 'off';
    await point(document.getElementById('a'));
    expect(asked).toEqual([]);
  });

  it('honours which key was chosen', async () => {
    key = 'shift';
    await point(document.getElementById('a'), { altKey: true });
    expect(asked).toEqual([]);

    await point(document.getElementById('a'), { shiftKey: true });
    expect(asked.map((block) => block.id)).toEqual(['a']);
  });

  it('offers the block, not the leaf under the pointer', async () => {
    // The pointer is over a <strong>; the unit anyone means is the paragraph
    // around it.
    const target = document.getElementById('a');
    const strong = document.createElement('strong');
    strong.textContent = 'emphasis';
    target?.appendChild(strong);

    await point(strong);
    expect(asked.map((block) => block.id)).toEqual(['a']);
  });

  it('does not ask twice for the same paragraph', async () => {
    const target = document.getElementById('a');
    await point(target);
    await point(target);
    await point(target);
    expect(asked).toHaveLength(1);
  });

  it('moves on when the pointer does', async () => {
    await point(document.getElementById('a'));
    await finish();
    await point(document.getElementById('b'));
    expect(asked.map((block) => block.id)).toEqual(['a', 'b']);
  });

  it('leaves a paragraph that already has a translation alone', async () => {
    const target = document.getElementById('a');
    target?.setAttribute(TRANSLATED_ATTR, '');
    await point(target);
    expect(asked).toEqual([]);
  });

  it('never offers something the reader is typing into', async () => {
    await point(document.getElementById('notes'));
    expect(asked).toEqual([]);
  });

  it('marks what it is about to translate, and stops marking afterwards', async () => {
    // The outline is the answer to "what will this key press do", and once the
    // translation is under the paragraph it would be marking a block that is
    // no longer offered.
    const target = document.getElementById('a');
    await point(target);
    expect(target?.classList.contains(HOVER_CLASS)).toBe(true);

    await finish();
    expect(document.querySelectorAll(`.${HOVER_CLASS}`)).toHaveLength(0);
  });

  it('drops the mark when the key is let go', async () => {
    // A key released while the pointer sits still produces no mousemove, so
    // nothing else would clear it.
    const target = document.getElementById('a');
    await point(target);
    expect(target?.classList.contains(HOVER_CLASS)).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(document.querySelectorAll(`.${HOVER_CLASS}`)).toHaveLength(0);
  });

  it('stops listening once unmounted', async () => {
    unmount?.();
    unmount = null;
    await point(document.getElementById('a'));
    expect(asked).toEqual([]);
  });
});
