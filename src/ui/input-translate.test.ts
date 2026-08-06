// @vitest-environment jsdom
/**
 * Translating the box you are typing in. The translation is the easy half; the
 * properties worth pinning are about not breaking the page around the field —
 * and about refusing the fields where "translate this" has an answer nobody
 * wants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  activeField,
  fieldText,
  translateActiveInput,
} from './input-translate';

const PAGE = `
  <input id="text" type="text" />
  <input id="password" type="password" />
  <input id="email" type="email" />
  <input id="readonly" type="text" readonly />
  <textarea id="notes"></textarea>
  <div id="rich" contenteditable="true"></div>
  <p id="prose">Not a field at all.</p>
`;

let inserted: string[];
let notes: string[];

/**
 * jsdom implements neither `execCommand` nor the selection plumbing behind it.
 * Standing in for it here keeps the *reason* it is used testable — the call is
 * made, and what would have gone in is recorded — while what it does to the
 * undo stack is a browser property no unit test can hold an opinion about.
 */
function stubExecCommand(succeeds = true): void {
  document.execCommand = vi.fn(
    (command: string, _ui?: boolean, value?: string) => {
      if (command !== 'insertText') return false;
      inserted.push(value ?? '');
      const field = document.activeElement;
      if (succeeds && field) {
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement
        ) {
          field.value = value ?? '';
        } else {
          field.textContent = value ?? '';
        }
      }
      return succeeds;
    },
  ) as typeof document.execCommand;
}

function deps(translate = (text: string) => Promise.resolve(`[en] ${text}`)) {
  return {
    translate,
    notify: (message: string) => notes.push(message),
  };
}

beforeEach(() => {
  document.body.innerHTML = PAGE;
  inserted = [];
  notes = [];
  stubExecCommand();
});

describe('activeField', () => {
  it('finds the text box the writer is in', () => {
    const field = document.getElementById('text') as HTMLInputElement;
    field.focus();
    expect(activeField(document)?.id).toBe('text');
  });

  it('finds a textarea and a contenteditable', () => {
    (document.getElementById('notes') as HTMLTextAreaElement).focus();
    expect(activeField(document)?.id).toBe('notes');

    (document.getElementById('rich') as HTMLElement).focus();
    expect(activeField(document)?.id).toBe('rich');
  });

  it('refuses a password box', () => {
    // A password is not to be read, let alone sent anywhere to be translated.
    (document.getElementById('password') as HTMLInputElement).focus();
    expect(activeField(document)).toBeNull();
  });

  it('refuses fields whose text is a value rather than prose', () => {
    // An email or a URL has nothing to translate and comes back mangled.
    (document.getElementById('email') as HTMLInputElement).focus();
    expect(activeField(document)).toBeNull();
  });

  it('refuses a field that cannot be written to', () => {
    (document.getElementById('readonly') as HTMLInputElement).focus();
    expect(activeField(document)).toBeNull();
  });

  it('is null when the writer is not in a field', () => {
    (document.getElementById('prose') as HTMLElement).focus();
    expect(activeField(document)).toBeNull();
  });

  it('looks inside an open shadow root', () => {
    // The focused element inside a component is reported as the host, so a
    // comment box in a web component would otherwise never be found.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('textarea');
    inner.id = 'inside';
    shadow.appendChild(inner);
    inner.focus();

    expect(activeField(document)?.id).toBe('inside');
  });
});

describe('translateActiveInput', () => {
  it('replaces what is in the box', async () => {
    const field = document.getElementById('notes') as HTMLTextAreaElement;
    field.value = '這是一段要翻成英文的字';
    field.focus();

    expect(await translateActiveInput(document, deps())).toBe('done');
    expect(inserted).toEqual(['[en] 這是一段要翻成英文的字']);
    expect(fieldText(field)).toBe('[en] 這是一段要翻成英文的字');
  });

  it('inserts rather than assigning, so the page and Ctrl+Z survive', async () => {
    // Setting `value` fires no `input` event, so React and Vue never learn the
    // field changed and revert it on the next render — and it wipes the undo
    // stack, so the writer cannot take back a translation they did not like.
    const field = document.getElementById('notes') as HTMLTextAreaElement;
    field.value = 'something';
    field.focus();
    await translateActiveInput(document, deps());

    expect(document.execCommand).toHaveBeenCalledWith(
      'insertText',
      false,
      '[en] something',
    );
  });

  it('says so when there is no box to translate', async () => {
    (document.getElementById('prose') as HTMLElement).focus();
    expect(await translateActiveInput(document, deps())).toBe('no-field');
    expect(notes.join(' ')).toContain('text box');
    expect(inserted).toEqual([]);
  });

  it('says so when the box is empty', async () => {
    const field = document.getElementById('text') as HTMLInputElement;
    field.value = '   ';
    field.focus();
    expect(await translateActiveInput(document, deps())).toBe('empty');
    expect(inserted).toEqual([]);
  });

  it('leaves the box alone when it is already in that language', async () => {
    const field = document.getElementById('text') as HTMLInputElement;
    field.value = 'already english';
    field.focus();
    expect(
      await translateActiveInput(document, deps((text) => Promise.resolve(text))),
    ).toBe('failed');
    expect(inserted).toEqual([]);
    expect(field.value).toBe('already english');
  });

  it('does not write into a box the writer has left', async () => {
    // A translation is a round trip, and writing into a field they clicked out
    // of during it is worse than not writing at all.
    const field = document.getElementById('notes') as HTMLTextAreaElement;
    field.value = 'something';
    field.focus();

    const run = translateActiveInput(
      document,
      deps(
        (text) =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve(`[en] ${text}`), 0);
          }),
      ),
    );
    (document.getElementById('text') as HTMLInputElement).focus();

    expect(await run).toBe('failed');
    expect(inserted).toEqual([]);
    expect(notes.join(' ')).toContain('moved out');
  });

  it('reports a browser that refuses the replacement', async () => {
    stubExecCommand(false);
    const field = document.getElementById('notes') as HTMLTextAreaElement;
    field.value = 'something';
    field.focus();

    expect(await translateActiveInput(document, deps())).toBe('failed');
    expect(notes.join(' ')).toContain('would not accept');
  });

  it('reports what the engine said when it fails', async () => {
    const field = document.getElementById('notes') as HTMLTextAreaElement;
    field.value = 'something';
    field.focus();

    expect(
      await translateActiveInput(
        document,
        deps(() =>
          Promise.reject(new Error("Can't reach Ollama at http://127.0.0.1:1.")),
        ),
      ),
    ).toBe('failed');
    expect(notes.join(' ')).toContain("Can't reach Ollama");
  });
});
