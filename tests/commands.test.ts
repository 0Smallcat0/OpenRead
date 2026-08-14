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

interface ResolvedManifest {
  commands?: Record<string, CommandDefinition>;
  permissions?: string[];
}

/**
 * The manifest as WXT will build it for one browser.
 *
 * `manifest` is typed as an object, a promise, or a function, and this project
 * moved to the function form when `declarativeNetRequest` had to be dropped
 * for Firefox — whose MV2 has no such API. The object-form cast that used to
 * be here silently read `commands` off a function, found nothing, and this
 * suite went red for the right reason: the shortcuts really would have been
 * unreadable that way.
 */
function resolve(browser: string): ResolvedManifest {
  const source = config.manifest as unknown as
    | ResolvedManifest
    | ((env: {
        browser: string;
        manifestVersion: number;
        mode: string;
        command: string;
      }) => ResolvedManifest);
  return typeof source === 'function'
    ? source({
        browser,
        manifestVersion: browser === 'firefox' ? 2 : 3,
        mode: 'production',
        command: 'build',
      })
    : source;
}

const commands = resolve('chrome').commands ?? {};

describe('keyboard commands', () => {
  it('declares every translate command', () => {
    expect(Object.keys(commands).sort()).toEqual([
      'translate-input',
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

describe('what each browser is asked for', () => {
  it('gives Firefox the same shortcuts as Chrome', () => {
    // The manifest is per-browser now, which is exactly the kind of change
    // that quietly drops a feature from one build.
    expect(Object.keys(resolve('firefox').commands ?? {}).sort()).toEqual(
      Object.keys(commands).sort(),
    );
  });

  it('asks Firefox for no declarativeNetRequest, and Chrome for one', () => {
    // Firefox gets the MV2 build and MV2 has no such API, so asking bought a
    // permission warning at install for something that could not be used —
    // and the worker called it anyway, which took the whole Firefox product
    // down with it until `applyOriginStripRule` was guarded.
    expect(resolve('firefox').permissions).not.toContain(
      'declarativeNetRequest',
    );
    expect(resolve('chrome').permissions).toContain('declarativeNetRequest');
  });
});
