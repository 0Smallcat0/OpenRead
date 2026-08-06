/**
 * Translating one paragraph, by pointing at it.
 *
 * Between the two things this already does. Selecting a sentence is precise and
 * costs a drag; translating the page is one press and rewrites everything. A
 * reader working through an article in their second language usually wants
 * neither — they want *this* paragraph, the one that stopped them, and they
 * want it without losing their place.
 *
 * Held key plus hover rather than hover alone: a paragraph that translates
 * itself because the mouse passed over it on the way to a link is a page that
 * fights back. The key makes it deliberate, and it is the only input that
 * cannot be produced by accident while reading.
 */
import { BLOCK_SELECTOR, OWN_UI, TRANSLATED_ATTR } from './blocks';

/** Which key has to be held. `off` mounts nothing. */
export type HoverKey = 'off' | 'alt' | 'ctrl' | 'shift';

/** Marks the block the reader is pointing at, so the key press has an answer. */
export const HOVER_CLASS = 'oit-hover-target';

const STYLE_ID = 'oit-hover-style';

export interface HoverDeps {
  /** Read at pointer time, so a change in the popup needs no reload. */
  getKey: () => Promise<HoverKey>;
  /**
   * Translate this block and attach the result. Resolves false when there was
   * nothing to do — already translated, or not worth a round trip.
   */
  translateBlock: (block: HTMLElement) => Promise<boolean>;
}

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // An outline rather than a border or a background: outlines do not take part
  // in layout, so highlighting a paragraph cannot reflow the page under the
  // cursor that is pointing at it.
  style.textContent = `
.${HOVER_CLASS} {
  outline: 2px solid currentColor;
  outline-offset: 2px;
  opacity: 0.99;
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function held(event: MouseEvent, key: HoverKey): boolean {
  if (key === 'alt') return event.altKey;
  if (key === 'ctrl') return event.ctrlKey;
  if (key === 'shift') return event.shiftKey;
  return false;
}

/**
 * The block under the pointer, if it is one worth offering.
 *
 * `elementFromPoint` rather than the event target, because the target is
 * whatever leaf the pointer is over — a `<strong>`, a link, a text node's
 * parent — and the unit being offered is the paragraph around it.
 */
function blockAt(doc: Document, x: number, y: number): HTMLElement | null {
  const at = doc.elementFromPoint(x, y);
  if (!at) return null;
  if (at.closest(OWN_UI)) return null;
  // Never our own inserted translation, and never something the reader is
  // typing into: both are cases where "translate what I am pointing at" has an
  // answer nobody wants.
  if (at.closest('input, textarea, select, [contenteditable="true"]')) {
    return null;
  }
  const block = at.closest<HTMLElement>(BLOCK_SELECTOR);
  if (!block || block.hasAttribute(TRANSLATED_ATTR)) return null;
  return block;
}

/**
 * Watch for the key-and-point gesture. Returns a function that unmounts it.
 *
 * One `mousemove` listener, reading the modifier off the event itself rather
 * than tracking key state separately — the browser already carries it, and two
 * sources of truth about whether Alt is down is one more than is needed.
 */
export function mountHoverTranslate(doc: Document, deps: HoverDeps): () => void {
  let key: HoverKey = 'off';
  let marked: HTMLElement | null = null;
  /** The block a translation is running for, so pointing again does not stack. */
  let busy: HTMLElement | null = null;

  const unmark = (): void => {
    marked?.classList.remove(HOVER_CLASS);
    marked = null;
  };

  const onMove = (event: MouseEvent): void => {
    void deps.getKey().then((current) => {
      key = current;
      if (key === 'off' || !held(event, key)) {
        unmark();
        return;
      }
      const block = blockAt(doc, event.clientX, event.clientY);
      if (!block) {
        unmark();
        return;
      }
      if (block === marked) return;
      unmark();
      ensureStyle(doc);
      block.classList.add(HOVER_CLASS);
      marked = block;

      if (busy === block) return;
      busy = block;
      void deps
        .translateBlock(block)
        .catch(() => undefined)
        .finally(() => {
          if (busy === block) busy = null;
          // The outline has done its job once the translation is under the
          // paragraph; leaving it would mark a block that is no longer offered.
          if (marked === block) unmark();
        });
    });
  };

  // A key released while the pointer sits still produces no `mousemove`, so the
  // outline would stay on a block that is no longer offered.
  const onKeyUp = (): void => {
    unmark();
  };

  doc.addEventListener('mousemove', onMove, { passive: true });
  doc.addEventListener('keyup', onKeyUp, { passive: true });
  return () => {
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('keyup', onKeyUp);
    unmark();
  };
}
