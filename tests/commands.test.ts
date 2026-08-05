/**
 * The keyboard shortcuts, pinned against Chrome's reserved combinations.
 *
 * Chrome does not reject a manifest that suggests a shortcut it has already
 * claimed. It installs the extension, registers the command, and leaves the
 * binding empty — `chrome.commands.getAll()` reports `shortcut: ""` and the key
 * does nothing. So a dead shortcut looks exactly like a working one from
 * inside the repository, and the only way to notice is to ask a real browser.
 *
 * `translate-page` shipped as `Ctrl+Shift+G` from 2.7.0 to 2.7.5. That is
 * Chrome's own "find previous", so whole-page translation had no keyboard
 * route at all for five releases while the README documented one. Probed
 * against Chrome 150: G came back empty, U/L/K each came back assigned.
 *
 * This test cannot ask Chrome anything. What it can do is stop a future edit
 * from walking back into a combination already known to be taken.
 */
import { describe, it, expect } from 'vitest';
import config from '../wxt.config';

/**
 * Chrome's own bindings, as far as this project has confirmed them. Not the
 * complete list — Chrome publishes none — so a key's absence here is "not
 * known to be taken", never "safe".
 */
const RESERVED = new Set([
  'Ctrl+Shift+G', // find previous — measured empty
  'Command+Shift+G',
  'Ctrl+G',
  'Ctrl+T',
  'Ctrl+N',
  'Ctrl+W',
  'Ctrl+Shift+T',
  'Ctrl+Shift+N',
  'Ctrl+Shift+W',
  'Ctrl+Shift+Q',
]);

interface CommandDefinition {
  suggested_key?: Record<string, string>;
  description?: string;
}

// `manifest` is typed as an object, a promise, or a function; this project
// writes the object form, and reading it needs the narrowing said out loud.
const manifest = config.manifest as {
  commands?: Record<string, CommandDefinition>;
};
const commands = manifest.commands ?? {};

describe('keyboard commands', () => {
  it('declares both translate commands', () => {
    expect(Object.keys(commands).sort()).toEqual([
      'translate-page',
      'translate-selection',
    ]);
  });

  for (const [name, command] of Object.entries(commands)) {
    it(`gives ${name} a shortcut Chrome is not known to reserve`, () => {
      const keys = Object.values(command.suggested_key ?? {});
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(RESERVED.has(key)).toBe(false);
    });

    it(`gives ${name} a description`, () => {
      // The description is the only label on chrome://extensions/shortcuts,
      // where a user goes to rebind a key that collides on their machine.
      expect(command.description).toBeTruthy();
    });
  }
});
