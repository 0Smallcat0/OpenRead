/**
 * Translating the box you are typing in.
 *
 * The other direction. Everything else here answers "what does this page say";
 * this answers "how do I say this" — a reply, a commit message, a bug report,
 * written in the language the writer thinks in and needed in the language the
 * reader wants.
 *
 * The interesting problem is not the translation. It is replacing text in a
 * field without breaking the page around it: setting `value` directly fires no
 * `input` event, so React and Vue never learn the field changed and revert it
 * on the next render, and it wipes the browser's undo stack, so Ctrl+Z cannot
 * take back a translation the writer did not like. `execCommand('insertText')`
 * is deprecated and is still the only call that does neither.
 */

/** Fields worth offering. */
const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

/**
 * Types where the text is a value rather than prose. A password is not to be
 * read, let alone translated; an email or a URL has nothing to translate and
 * would come back mangled.
 */
const NOT_PROSE = new Set([
  'password',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
  'range',
  'file',
  'hidden',
  'checkbox',
  'radio',
  'submit',
  'button',
  'image',
  'reset',
]);

export interface InputTranslateDeps {
  /** Translate this text into the writer's chosen output language. */
  translate: (text: string) => Promise<string>;
  /** Say something to the writer. The caller decides where. */
  notify?: (message: string) => void;
}

export type InputTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

/**
 * The field the writer is in, or null.
 *
 * Deep, because the focused element inside an open shadow root is reported as
 * the host: a comment box in a web component would otherwise never be found.
 */
export function activeField(doc: Document): InputTarget | null {
  let element: Element | null = doc.activeElement;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  if (!element || !(element instanceof (doc.defaultView?.HTMLElement ?? HTMLElement))) {
    return null;
  }
  if (!element.matches(EDITABLE)) return null;
  if (element instanceof (doc.defaultView?.HTMLInputElement ?? HTMLInputElement)) {
    if (NOT_PROSE.has(element.type.toLowerCase())) return null;
  }
  if ('readOnly' in element && (element as HTMLInputElement).readOnly) return null;
  if ('disabled' in element && (element as HTMLInputElement).disabled) return null;
  return element;
}

/** What is in it. */
export function fieldText(field: InputTarget): string {
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    return field.value;
  }
  return field.textContent ?? '';
}

/**
 * Put `text` in, the way a person typing would.
 *
 * Select everything, then insert over it. `execCommand` is deprecated and no
 * replacement exists that keeps both halves of what makes this usable: the
 * `input` event that tells a framework its state is stale, and the entry in the
 * browser's own undo stack that lets Ctrl+Z put the original back. Assigning to
 * `value` gives neither.
 *
 * Returns false when the browser refused, so the caller can say so rather than
 * leave the writer looking at an unchanged box wondering.
 */
export function replaceFieldText(field: InputTarget, text: string): boolean {
  const doc = field.ownerDocument;
  field.focus();
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    field.setSelectionRange(0, field.value.length);
  } else {
    const range = doc.createRange();
    range.selectNodeContents(field);
    const selection = doc.defaultView?.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  try {
    return doc.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

/**
 * Translate whatever the writer is currently typing in.
 *
 * Resolves to what happened, so the caller can report it without repeating the
 * reasoning: there was no field, the field was empty, or it was replaced.
 */
export async function translateActiveInput(
  doc: Document,
  deps: InputTranslateDeps,
): Promise<'no-field' | 'empty' | 'failed' | 'done'> {
  const field = activeField(doc);
  if (!field) {
    deps.notify?.('Click into a text box first, then press the shortcut.');
    return 'no-field';
  }
  const source = fieldText(field).trim();
  if (!source) {
    deps.notify?.('Nothing written yet.');
    return 'empty';
  }
  try {
    const translated = (await deps.translate(source)).trim();
    if (!translated || translated === source) {
      deps.notify?.('It is already in that language.');
      return 'failed';
    }
    // Re-read rather than trust the reference: a translation is a round trip,
    // and the writer may have clicked elsewhere while it ran. Writing into a
    // box they have left is worse than not writing at all.
    if (activeField(doc) !== field) {
      deps.notify?.('You moved out of the box, so nothing was changed.');
      return 'failed';
    }
    if (!replaceFieldText(field, translated)) {
      deps.notify?.('This box would not accept the replacement.');
      return 'failed';
    }
    return 'done';
  } catch (error) {
    deps.notify?.(error instanceof Error ? error.message : String(error));
    return 'failed';
  }
}
