/**
 * The background worker is thin, but it is not trivial: it owns the streaming
 * broker's cancellation, the only place a network failure is turned into
 * something a user can act on, PDF routing, and the keyboard command. All of it
 * was untested. These tests stub `chrome` and the API client, run the worker's
 * registration callback, and then drive the listeners it registered.
 *
 * Not co-located like every other test in this repo: WXT treats every file
 * under `src/entrypoints/` as an entrypoint, so a `background.test.ts` beside
 * `background.ts` collides with it and breaks `wxt prepare`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamResponse } from '../src/messaging';

const mocks = vi.hoisted(() => ({
  translateStream: vi.fn(),
  enrichText: vi.fn(),
  loadSettings: vi.fn(),
  packAvailability: vi.fn(),
  downloadPack: vi.fn(),
  translateBuiltin: vi.fn(),
}));

vi.mock('../src/api/ollama', () => ({
  translateStream: mocks.translateStream,
  enrichText: mocks.enrichText,
}));
vi.mock('../src/settings', () => ({ loadSettings: mocks.loadSettings }));
// Only the two the pack prefetch drives. `translateBuiltin` and
// `BuiltinUnavailableError` stay real: the worker tests an error with
// `instanceof`, and a stand-in class would pass the check while being the
// wrong type everywhere else.
vi.mock('../src/api/builtin', async () => {
  const actual =
    await vi.importActual<typeof import('../src/api/builtin')>(
      '../src/api/builtin',
    );
  return {
    ...actual,
    packAvailability: mocks.packAvailability,
    downloadPack: mocks.downloadPack,
    // Passed through by default: almost every test here wants the real thing,
    // which without a `Translator` global declines and falls through to Ollama.
    translateBuiltin: (...args: unknown[]) =>
      mocks.translateBuiltin.getMockImplementation()
        ? mocks.translateBuiltin(...args)
        : (actual.translateBuiltin as (...a: unknown[]) => unknown)(...args),
  };
});

const VIEWER = 'chrome-extension://abc/pdfjs/web/viewer.html';
const BASE_URL = 'http://localhost:11434';

/** The listeners the worker registered, captured as it registers them. */
interface Registered {
  onUpdated: (
    tabId: number,
    changeInfo: { status?: string },
    tab: { url?: string },
  ) => void;
  onCommand: (command: string) => void;
  onStartup: () => void;
  onInstalled: () => void;
  onStorageChanged: (changes: Record<string, unknown>, area: string) => void;
  onConnect: (port: FakePort) => void;
  onMessage: (
    request: unknown,
    // `url` matters as much as `id` now: the PDF route reads the address from
    // the sender rather than the message, so a stub without one cannot tell a
    // legitimate route from a page naming somebody else's tab.
    sender: { tab?: { id?: number; url?: string }; url?: string },
    sendResponse: (response: unknown) => void,
  ) => unknown;
}

class FakePort {
  name: string;
  readonly posted: StreamResponse[] = [];
  private messageListeners: ((message: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  constructor(name: string) {
    this.name = name;
  }

  onMessage = {
    addListener: (fn: (message: unknown) => void) => {
      this.messageListeners.push(fn);
    },
  };
  onDisconnect = {
    addListener: (fn: () => void) => {
      this.disconnectListeners.push(fn);
    },
  };
  postMessage(message: StreamResponse): void {
    this.posted.push(message);
  }

  send(message: unknown): void {
    for (const fn of this.messageListeners) fn(message);
  }
  hangUp(): void {
    for (const fn of this.disconnectListeners) fn();
  }
}

let registered: Registered;
let tabsUpdate: ReturnType<typeof vi.fn>;
let tabsQuery: ReturnType<typeof vi.fn>;
let tabsSendMessage: ReturnType<typeof vi.fn>;
let fileSchemeAllowed: boolean;
let sessionRules: ReturnType<typeof vi.fn>;
let createdMenus: { id: string; title: string; contexts: string[] }[];
let menuClick: (info: { menuItemId: string }, tab?: { id?: number }) => void;
let startupListeners: (() => void)[];
let installedListeners: (() => void)[];
/** Everything written to the toolbar icon, in order. */
let badges: { text?: string; title?: string }[];
/** How often the worker has poked a `chrome.*` API to stay alive. */
let platformInfoCalls: number;

/** Let the worker's awaited `loadSettings()` and stream call resolve. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  mocks.translateStream.mockReset();
  mocks.enrichText.mockReset();
  mocks.loadSettings.mockReset().mockResolvedValue({ baseUrl: BASE_URL });
  // "Already on disk" is the state every test that is not about the prefetch
  // wants: nothing to download, so nothing to assert around.
  mocks.packAvailability.mockReset().mockResolvedValue('available');
  mocks.downloadPack.mockReset().mockResolvedValue(undefined);
  mocks.translateBuiltin.mockReset();
  platformInfoCalls = 0;
  fileSchemeAllowed = true;
  tabsUpdate = vi.fn().mockResolvedValue(undefined);
  tabsQuery = vi.fn().mockResolvedValue([{ id: 7 }]);
  tabsSendMessage = vi.fn().mockResolvedValue(undefined);
  sessionRules = vi.fn().mockResolvedValue(undefined);
  createdMenus = [];
  menuClick = () => undefined;
  startupListeners = [];
  installedListeners = [];
  badges = [];

  const partial: Partial<Registered> = {};
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: () => VIEWER,
      // What the pack prefetch pokes to keep the worker off the reaper.
      getPlatformInfo: () => {
        platformInfoCalls += 1;
        return Promise.resolve({ os: 'win' });
      },
      onConnect: {
        addListener: (fn: Registered['onConnect']) => {
          partial.onConnect = fn;
        },
      },
      onMessage: {
        addListener: (fn: Registered['onMessage']) => {
          partial.onMessage = fn;
        },
      },
      // Collected, not overwritten: PDF routing and the Origin-strip rule
      // both register here, and keeping only the last would silently drop one.
      onStartup: {
        addListener: (fn: () => void) => {
          startupListeners.push(fn);
        },
      },
      onInstalled: {
        addListener: (fn: () => void) => {
          installedListeners.push(fn);
        },
      },
    },
    tabs: {
      onUpdated: {
        addListener: (fn: Registered['onUpdated']) => {
          partial.onUpdated = fn;
        },
      },
      update: tabsUpdate,
      query: tabsQuery,
      sendMessage: tabsSendMessage,
    },
    commands: {
      onCommand: {
        addListener: (fn: Registered['onCommand']) => {
          partial.onCommand = fn;
        },
      },
    },
    action: {
      setBadgeText: ({ text }: { text: string }) => {
        badges.push({ text });
        return Promise.resolve();
      },
      setTitle: ({ title }: { title: string }) => {
        badges.push({ title });
        return Promise.resolve();
      },
    },
    extension: {
      isAllowedFileSchemeAccess: () => Promise.resolve(fileSchemeAllowed),
    },
    storage: {
      onChanged: {
        addListener: (fn: Registered['onStorageChanged']) => {
          partial.onStorageChanged = fn;
        },
      },
    },
    declarativeNetRequest: {
      updateSessionRules: sessionRules,
    },
    contextMenus: {
      removeAll: (done: () => void) => {
        createdMenus = [];
        done();
      },
      create: (item: { id: string; title: string; contexts: string[] }) => {
        createdMenus.push(item);
      },
      onClicked: {
        addListener: (fn: typeof menuClick) => {
          menuClick = fn;
        },
      },
    },
  });
  partial.onStartup = () => {
    for (const fn of startupListeners) fn();
  };
  partial.onInstalled = () => {
    for (const fn of installedListeners) fn();
  };
  // WXT auto-imports this; here it just hands back the registration callback.
  vi.stubGlobal('defineBackground', (fn: () => void) => fn);

  const module = (await import('../src/entrypoints/background')) as unknown as {
    default: () => void;
  };
  module.default();
  registered = partial as Registered;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the language pack, fetched before it is wanted', () => {
  const BUILTIN = {
    baseUrl: BASE_URL,
    engine: 'builtin',
    targetLang: 'Traditional Chinese',
  };

  /**
   * Longer than `settle`: the prefetch awaits settings, then availability,
   * then the download itself, and each hop is a tick this has to outlast.
   */
  async function drain(): Promise<void> {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }

  it('downloads it on install rather than leaving it to the first press', async () => {
    // The whole point. Measured against the shipped build on a profile that
    // had never translated: six minutes after the first press the page was
    // still empty and Chrome's pack was at 43%.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    registered.onInstalled();
    await drain();

    expect(mocks.downloadPack).toHaveBeenCalledWith(
      'en',
      'zh-Hant',
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('asks again on browser startup, because Chrome does not resume', async () => {
    // An interrupted download is not picked up where it stopped: availability
    // went back to `downloadable`, not `downloading`, and the next attempt
    // started from zero. Somebody has to ask again, and this is who.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    registered.onStartup();
    await drain();

    expect(mocks.downloadPack).toHaveBeenCalledWith(
      'en',
      'zh-Hant',
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('leaves a pack that is already on disk alone', async () => {
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('available');
    registered.onInstalled();
    await drain();

    expect(mocks.downloadPack).not.toHaveBeenCalled();
  });

  it('does not download one for a user who translates with Ollama', async () => {
    mocks.loadSettings.mockResolvedValue({ ...BUILTIN, engine: 'ollama' });
    mocks.packAvailability.mockResolvedValue('downloadable');
    registered.onInstalled();
    await drain();

    expect(mocks.downloadPack).not.toHaveBeenCalled();
  });

  it('says nothing about a pair Chrome cannot serve', async () => {
    // A target only Ollama has. There is no BCP-47 code to ask Chrome about,
    // so there is nothing to fetch and nothing to complain about either.
    mocks.loadSettings.mockResolvedValue({ ...BUILTIN, targetLang: 'Klingon' });
    registered.onInstalled();
    await drain();

    expect(mocks.packAvailability).not.toHaveBeenCalled();
    expect(mocks.downloadPack).not.toHaveBeenCalled();
  });

  it('fetches the new pair when the target language changes', async () => {
    // Switching language names a pack that is not on disk either — the same
    // wait as a fresh install, met in the middle of using the thing.
    mocks.loadSettings.mockResolvedValue({
      ...BUILTIN,
      targetLang: 'Japanese',
    });
    mocks.packAvailability.mockResolvedValue('downloadable');
    registered.onStorageChanged(
      { targetLang: { newValue: 'Japanese' } },
      'sync',
    );
    await drain();

    expect(mocks.downloadPack).toHaveBeenCalledWith(
      'en',
      'ja',
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('ignores a change in some other area', async () => {
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    registered.onStorageChanged(
      { targetLang: { newValue: 'Japanese' } },
      'local',
    );
    await drain();

    expect(mocks.downloadPack).not.toHaveBeenCalled();
  });

  it('does not start a second download on top of the one already running', async () => {
    // Install and startup both fire on an update, and the storage listener
    // fires on any settings write. Two `Translator.create()` calls for one
    // pair is at best wasted and at worst two component-updater jobs racing.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    mocks.downloadPack.mockReturnValue(new Promise<void>(() => undefined));
    registered.onInstalled();
    await drain();
    registered.onStartup();
    await drain();

    expect(mocks.downloadPack).toHaveBeenCalledTimes(1);
  });

  it('puts the download on the toolbar icon, where a new install is looking', async () => {
    // Every other report of this download needs the user to press or open
    // something first, which is the wrong order: what they need to know is
    // that pressing anything is pointless for the next few minutes.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    mocks.downloadPack.mockImplementation(
      (_source: string, _target: string, onProgress: (n: number) => void) => {
        onProgress(0);
        onProgress(0.42);
        return new Promise<void>(() => undefined);
      },
    );
    registered.onInstalled();
    await drain();

    const texts = badges.map((b) => b.text).filter((t) => t !== undefined);
    // No percentage to open with: the monitor fired 479 times for one pair and
    // twice for another, so "0%" would sit there looking stuck.
    expect(texts[0]).toBe('↓');
    expect(texts).toContain('42%');
    expect(texts).not.toContain('0%');
  });

  it('takes the badge off once the pack is there', async () => {
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    registered.onInstalled();
    await drain();

    // Filtered on `undefined` rather than on truthiness: the value being
    // asserted is the empty string, which is what takes a badge off.
    expect(
      badges
        .map((b) => b.text)
        .filter((t) => t !== undefined)
        .at(-1),
    ).toBe('');
  });

  it('leaves a mark on the icon when the download gave up', async () => {
    // The state most worth noticing. Clearing the icon would hide it behind a
    // popup the user has no reason to open.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    mocks.downloadPack.mockRejectedValue(new Error('has not moved'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registered.onInstalled();
    await drain();
    warn.mockRestore();

    expect(
      badges
        .map((b) => b.text)
        .filter(Boolean)
        .at(-1),
    ).toBe('!');
  });

  it('keeps the worker up for a download the reader walked away from', async () => {
    // The install-time fetch covers `en` -> the configured target. A page in
    // some other language starts its pack here instead, mid-translation, and
    // the only thing holding the worker up for it is the port — which dies
    // with the tab. Measured on a pack interrupted at 85 MB: Chrome sat on it
    // for three minutes, deleted it, and started again, finishing at 436 s
    // against 82 s for the same pair left alone.
    // The shared fixture stores the Ollama engine; this branch only runs for
    // the other one.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    vi.useFakeTimers();
    try {
      mocks.translateBuiltin.mockImplementation(
        async (params: { onDownloadProgress?: (n: number) => void }) => {
          params.onDownloadProgress?.(0.1);
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      );
      const port = new FakePort('stream-translate');
      registered.onConnect(port);
      port.send({
        type: 'START_STREAM',
        text: 'A paragraph in a language nobody prefetched.',
        targetLang: 'Traditional Chinese',
        model: 'qwen3:latest',
      });
      await vi.advanceTimersByTimeAsync(100);

      // The reader gives up and closes the tab.
      port.hangUp();
      const atAbort = platformInfoCalls;
      await vi.advanceTimersByTimeAsync(60_000);

      // Still being poked a minute later, with no port and no page left.
      expect(platformInfoCalls).toBeGreaterThan(atAbort);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go of the worker once the pack has landed', async () => {
    // A translation that finished is proof the download did too, and holding
    // the worker up past that is a timer running for nothing.
    // The shared fixture stores the Ollama engine; this branch only runs for
    // the other one.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    vi.useFakeTimers();
    try {
      mocks.translateBuiltin.mockImplementation(
        async (params: {
          onDownloadProgress?: (n: number) => void;
          onChunk: (c: string) => void;
        }) => {
          params.onDownloadProgress?.(0.1);
          params.onChunk('你好');
        },
      );
      const port = new FakePort('stream-translate');
      registered.onConnect(port);
      port.send({
        type: 'START_STREAM',
        text: 'Hello',
        targetLang: 'Traditional Chinese',
        model: 'qwen3:latest',
      });
      await vi.advanceTimersByTimeAsync(100);
      const afterDone = platformInfoCalls;
      await vi.advanceTimersByTimeAsync(120_000);

      expect(platformInfoCalls).toBe(afterDone);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the popup a fetch is in flight, and how far in', async () => {
    // The popup cannot work this out for itself: `Translator.availability()`
    // answers `downloadable` for the whole duration of a download it is
    // performing, so without this it reports "nothing downloaded yet" over a
    // pack that is a third of the way in, and offers a button to start it.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    mocks.downloadPack.mockImplementation(
      (_source: string, _target: string, onProgress: (n: number) => void) => {
        onProgress(0.34);
        return new Promise<void>(() => undefined);
      },
    );
    registered.onInstalled();
    await drain();

    const answered = vi.fn();
    registered.onMessage({ type: 'PACK_PROGRESS' }, {}, answered);
    expect(answered).toHaveBeenCalledWith({
      downloading: true,
      loaded: 0.34,
      problem: null,
    });
  });

  it('answers the popup asking it to take a download', async () => {
    // Not politeness: `chrome.runtime.sendMessage` rejects with "Could not
    // establish connection. Receiving end does not exist." when a listener
    // returns without replying, and the popup showed that to the user as the
    // reason its download would not start.
    mocks.packAvailability.mockResolvedValue('downloadable');
    const answered = vi.fn();
    registered.onMessage(
      { type: 'PACK_FETCH', source: 'en', target: 'ja' },
      {},
      answered,
    );
    await drain();

    expect(answered).toHaveBeenCalledWith({ ok: true });
    expect(mocks.downloadPack).toHaveBeenCalledWith(
      'en',
      'ja',
      expect.any(Function),
      expect.any(Number),
    );
  });

  it('says nothing is in flight when nothing is', async () => {
    const answered = vi.fn();
    registered.onMessage({ type: 'PACK_PROGRESS' }, {}, answered);
    expect(answered).toHaveBeenCalledWith({
      downloading: false,
      loaded: 0,
      problem: null,
    });
  });

  it('passes on why the last attempt gave up', async () => {
    // A stalled component download is what a new install meets, and a
    // `console.warn` is not a report: nobody opens a devtools window on a
    // service worker to find out why the extension they just installed is not
    // translating.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    mocks.downloadPack.mockRejectedValue(
      new Error(
        "Chrome's language-pack download has not moved for three minutes.",
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registered.onInstalled();
    await drain();
    warn.mockRestore();

    const answered = vi.fn();
    registered.onMessage({ type: 'PACK_PROGRESS' }, {}, answered);
    expect(answered).toHaveBeenCalledWith({
      downloading: false,
      loaded: 0,
      problem: expect.stringContaining('has not moved'),
    });
  });

  it('survives a download that fails', async () => {
    // Nothing is lost by this failing: the first translation fetches the pack
    // the old way. An unhandled rejection in the worker would be worse than
    // the wait it is trying to avoid.
    mocks.loadSettings.mockResolvedValue(BUILTIN);
    mocks.packAvailability.mockResolvedValue('downloadable');
    mocks.downloadPack.mockRejectedValue(new Error('the updater never moved'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    registered.onInstalled();
    await drain();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    // And the next ask is not blocked by the failed one still looking busy.
    mocks.downloadPack.mockResolvedValue(undefined);
    registered.onStartup();
    await drain();
    expect(mocks.downloadPack).toHaveBeenCalledTimes(2);
  });
});

describe('PDF routing', () => {
  it('redirects a .pdf navigation into the bundled viewer', async () => {
    registered.onUpdated(
      3,
      { status: 'loading' },
      { url: 'https://example.com/paper.pdf' },
    );
    await settle();

    expect(tabsUpdate).toHaveBeenCalledWith(3, {
      url: `${VIEWER}?file=${encodeURIComponent('https://example.com/paper.pdf')}`,
    });
  });

  it('leaves ordinary pages alone', async () => {
    registered.onUpdated(
      3,
      { status: 'loading' },
      { url: 'https://example.com/article' },
    );
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('does not redirect the viewer into itself', async () => {
    // The viewer's own URL ends in .pdf once the file parameter is appended.
    registered.onUpdated(
      3,
      { status: 'loading' },
      { url: `${VIEWER}?file=x.pdf` },
    );
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('skips a local PDF when file access has not been granted', async () => {
    // Redirecting would land the user on a viewer that cannot read the file.
    fileSchemeAllowed = false;
    registered.onUpdated(
      3,
      { status: 'loading' },
      { url: 'file:///C:/papers/attention.pdf' },
    );
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });
});

describe('PDF tabs that were already open when the worker woke', () => {
  it('sweeps them into the viewer on startup', async () => {
    // Launching the browser straight onto a PDF puts the navigation past
    // `loading` before MV3 starts the worker, so onUpdated never sees it.
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://example.com/paper.pdf' },
      { id: 2, url: 'https://example.com/article' },
    ]);
    registered.onStartup();
    await settle();

    expect(tabsUpdate).toHaveBeenCalledTimes(1);
    expect(tabsUpdate).toHaveBeenCalledWith(1, {
      url: `${VIEWER}?file=${encodeURIComponent('https://example.com/paper.pdf')}`,
    });
  });

  it('sweeps them on install too, not only on browser startup', async () => {
    tabsQuery.mockResolvedValue([{ id: 3, url: 'https://example.com/a.pdf' }]);
    registered.onInstalled();
    await settle();

    expect(tabsUpdate).toHaveBeenCalledWith(3, expect.anything());
  });

  it('does not send the viewer into itself', async () => {
    tabsQuery.mockResolvedValue([{ id: 4, url: `${VIEWER}?file=x.pdf` }]);
    registered.onStartup();
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('still honours the file-scheme permission during the sweep', async () => {
    fileSchemeAllowed = false;
    tabsQuery.mockResolvedValue([{ id: 5, url: 'file:///C:/a.pdf' }]);
    registered.onStartup();
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });
});

describe('the keyboard command', () => {
  it('asks the active tab to translate its selection', async () => {
    registered.onCommand('translate-selection');
    await settle();

    expect(tabsSendMessage).toHaveBeenCalledWith(7, {
      type: 'TRANSLATE_SELECTION',
    });
  });

  it('ignores other commands', async () => {
    registered.onCommand('something-else');
    await settle();

    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('survives a tab with no content script listening', async () => {
    // sendMessage rejects when no receiver exists; that is expected, not a bug.
    tabsSendMessage.mockRejectedValue(
      new Error('Receiving end does not exist'),
    );
    registered.onCommand('translate-selection');
    await settle();

    expect(tabsSendMessage).toHaveBeenCalled();
  });
});

describe('the streaming broker', () => {
  function connect(): FakePort {
    const port = new FakePort('stream-translate');
    registered.onConnect(port);
    return port;
  }

  it('ignores ports it does not own', () => {
    const port = new FakePort('some-other-port');
    registered.onConnect(port);
    port.send({ type: 'START_STREAM', text: 'hi' });

    expect(mocks.translateStream).not.toHaveBeenCalled();
  });

  it('streams chunks back and closes with done', async () => {
    mocks.translateStream.mockImplementation(
      async (params: { onChunk: (c: string) => void }) => {
        params.onChunk('你好');
        params.onChunk('世界');
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello world',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
    await settle();

    expect(port.posted).toEqual([
      { status: 'streaming', chunk: '你好' },
      { status: 'streaming', chunk: '世界' },
      { status: 'done' },
    ]);
  });

  it('hides a glossary term from the engine and puts it back after', async () => {
    mocks.loadSettings.mockResolvedValue({
      baseUrl: BASE_URL,
      glossary: 'OpenRead',
    });
    let seen = '';
    mocks.translateStream.mockImplementation(
      async (params: { text: string; onChunk: (c: string) => void }) => {
        seen = params.text;
        params.onChunk('[[0]] 很快。');
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'OpenRead is fast.',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
    await settle();

    // The engine never saw the term at all, which is the point: it cannot
    // translate what it was not given.
    expect(seen).toBe('[[0]] is fast.');
    expect(port.posted).toEqual([
      { status: 'streaming', chunk: 'OpenRead 很快。' },
      { status: 'done' },
    ]);
  });

  it('translates again unprotected when a placeholder does not survive', async () => {
    mocks.loadSettings.mockResolvedValue({
      baseUrl: BASE_URL,
      glossary: 'OpenRead',
    });
    const sent: string[] = [];
    mocks.translateStream.mockImplementation(
      async (params: { text: string; onChunk: (c: string) => void }) => {
        sent.push(params.text);
        // The placeholder was eaten — measured behaviour for some target
        // languages with other placeholder shapes, so worth handling here.
        params.onChunk(sent.length === 1 ? '很快。' : '開放閱讀很快。');
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'OpenRead is fast.',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
    await settle();

    expect(sent).toEqual(['[[0]] is fast.', 'OpenRead is fast.']);
    // A translated term, not a sentence with the subject missing.
    expect(port.posted).toEqual([
      { status: 'streaming', chunk: '開放閱讀很快。' },
      { status: 'done' },
    ]);
  });

  it('leaves a block with no glossary term streaming as before', async () => {
    mocks.loadSettings.mockResolvedValue({
      baseUrl: BASE_URL,
      glossary: 'OpenRead',
    });
    mocks.translateStream.mockImplementation(
      async (params: { onChunk: (c: string) => void }) => {
        params.onChunk('你好');
        params.onChunk('世界');
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello world',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
    await settle();

    // Two chunks, not one: buffering is the price of the glossary and is paid
    // only by the blocks that use it.
    expect(port.posted).toEqual([
      { status: 'streaming', chunk: '你好' },
      { status: 'streaming', chunk: '世界' },
      { status: 'done' },
    ]);
  });

  it('does not protect a block that is nothing but the term', async () => {
    mocks.loadSettings.mockResolvedValue({
      baseUrl: BASE_URL,
      glossary: 'OpenRead',
    });
    const sent: string[] = [];
    mocks.translateStream.mockImplementation(
      async (params: { text: string; onChunk: (c: string) => void }) => {
        sent.push(params.text);
        params.onChunk('OpenRead');
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'OpenRead',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
    await settle();

    // Every call, not the last one. Recording only the last passed with the
    // guard removed: the protected attempt lost its placeholder, the
    // unprotected retry ran with the original text, and the assertion read
    // that retry and called it a pass.
    //
    // `[[0]]` on its own has no language to detect, and the built-in engine
    // answers that with "Could not tell what language this is written in" —
    // an error, on a heading that needed no translating.
    expect(sent).toEqual(['OpenRead']);
  });

  it('reads the Ollama URL itself instead of taking it from the message', async () => {
    // The base URL must never ride the message bus.
    mocks.translateStream.mockResolvedValue(undefined);
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello',
      targetLang: 'English',
      model: 'qwen3:latest',
    });
    await settle();

    expect(mocks.translateStream.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: BASE_URL,
      text: 'Hello',
      model: 'qwen3:latest',
    });
  });

  it('turns a network failure into something the user can act on', async () => {
    // fetch rejects with a TypeError when the server is not running.
    mocks.translateStream.mockRejectedValue(new TypeError('Failed to fetch'));
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello',
      model: 'm',
      targetLang: 'English',
    });
    await settle();

    const error = port.posted.at(-1) as { status: string; message: string };
    expect(error.status).toBe('error');
    expect(error.message).toContain(BASE_URL);
    // No longer mentions OLLAMA_ORIGINS. The Origin-strip rule removed that
    // as a thing a user has to know about, so naming it here would send
    // someone to configure a server that is already configured correctly.
    expect(error.message).not.toContain('OLLAMA_ORIGINS');
    expect(error.message).toContain('running');
  });

  it('passes any other failure through verbatim', async () => {
    mocks.translateStream.mockRejectedValue(
      new Error('Ollama 404: model not found'),
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello',
      model: 'm',
      targetLang: 'English',
    });
    await settle();

    expect(port.posted.at(-1)).toEqual({
      status: 'error',
      message: 'Ollama 404: model not found',
    });
  });

  it('stays silent when the user cancelled', async () => {
    // An abort is the user's own doing; reporting it as an error would put a
    // warning in the panel every time a new selection replaces an old one.
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    mocks.translateStream.mockRejectedValue(abort);
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello',
      model: 'm',
      targetLang: 'English',
    });
    await settle();

    expect(port.posted).toEqual([]);
  });

  it('aborts the previous request when a new one starts on the same port', async () => {
    const signals: AbortSignal[] = [];
    mocks.translateStream.mockImplementation(
      (params: { signal: AbortSignal }) => {
        signals.push(params.signal);
        return new Promise(() => undefined);
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'first',
      model: 'm',
      targetLang: 'English',
    });
    await settle();
    port.send({
      type: 'START_STREAM',
      text: 'second',
      model: 'm',
      targetLang: 'English',
    });
    await settle();

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('aborts in-flight work when the panel closes', async () => {
    let signal: AbortSignal | undefined;
    mocks.translateStream.mockImplementation(
      (params: { signal: AbortSignal }) => {
        signal = params.signal;
        return new Promise(() => undefined);
      },
    );
    const port = connect();
    port.send({
      type: 'START_STREAM',
      text: 'Hello',
      model: 'm',
      targetLang: 'English',
    });
    await settle();
    port.hangUp();

    expect(signal?.aborted).toBe(true);
  });
});

describe('one-shot handlers', () => {
  it('returns an enrichment result', async () => {
    mocks.enrichText.mockResolvedValue({ title: 'Fetch API', tags: ['web'] });
    const sendResponse = vi.fn();
    registered.onMessage(
      {
        type: 'ENRICH_CAPTURE',
        text: 'body',
        model: 'qwen3:latest',
        targetLang: 'Traditional Chinese',
      },
      {},
      sendResponse,
    );
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({
      result: { title: 'Fetch API', tags: ['web'] },
    });
  });

  it('answers with null when enrichment fails, so the capture still happens', async () => {
    // Enrichment is best-effort: small models are unreliable at structured
    // output and a capture must not be lost to that.
    mocks.enrichText.mockRejectedValue(new Error('model exploded'));
    const sendResponse = vi.fn();
    registered.onMessage(
      {
        type: 'ENRICH_CAPTURE',
        text: 'body',
        model: 'qwen3:latest',
        targetLang: 'Traditional Chinese',
      },
      {},
      sendResponse,
    );
    await settle();

    expect(sendResponse).toHaveBeenCalledWith({ result: null });
  });

  it('puts a tab that is showing a PDF into the bundled viewer', async () => {
    // The address said nothing: arxiv.org serves every paper from
    // `/pdf/1706.03762`, with no extension anywhere in it. The tab itself is
    // what knows, from `document.contentType`.
    registered.onMessage(
      { type: 'OPEN_IN_VIEWER' },
      { tab: { id: 7, url: 'https://arxiv.org/pdf/1706.03762' } },
      vi.fn(),
    );
    await settle();

    expect(tabsUpdate).toHaveBeenCalledWith(7, {
      url: expect.stringContaining(
        encodeURIComponent('https://arxiv.org/pdf/1706.03762'),
      ),
    });
  });

  it('takes the URL from the sender, never from the message', async () => {
    // A page that could name both a tab and a URL could navigate somebody
    // else's tab, so neither is read from the message at all.
    tabsUpdate.mockClear();
    registered.onMessage({ type: 'OPEN_IN_VIEWER' }, {}, vi.fn());
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('does not send the viewer into itself', async () => {
    tabsUpdate.mockClear();
    registered.onMessage(
      { type: 'OPEN_IN_VIEWER' },
      {
        tab: {
          id: 7,
          url: 'chrome-extension://abc/pdfjs/web/viewer.html?file=x',
        },
      },
      vi.fn(),
    );
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it('does not hold the channel open for a message it does not handle', () => {
    expect(
      registered.onMessage({ type: 'SOMETHING_ELSE' }, {}, vi.fn()),
    ).toBeUndefined();
  });
});

describe('a browser with no declarativeNetRequest', () => {
  it('still translates, instead of hanging with nothing said', async () => {
    // How the Firefox build managed to translate nothing at all from 2.5.0 to
    // 2.21.0 with no report: MV2 has no such API, so the start-up call threw,
    // `originRuleReady` stayed a rejected promise, and the rejection escaped
    // the request handler — `await originRuleReady` sits outside its try — so
    // the port was never answered and the panel translated forever in silence.
    // Firefox is no longer a target. The test stays because the failure shape
    // is not Firefox-specific: a quota error or a rejected rule on Chrome
    // reaches the port the same way, which is to say not at all.
    const stub = globalThis.chrome as unknown as Record<string, unknown>;
    delete stub.declarativeNetRequest;
    // Re-run the worker's start-up, which is where the rule is installed.
    registered.onStartup();
    await settle();

    mocks.translateStream.mockImplementation(
      async (params: { onChunk: (c: string) => void }) => {
        params.onChunk('你好');
      },
    );
    const port = new FakePort('stream-translate');
    registered.onConnect(port);
    port.send({
      type: 'START_STREAM',
      text: 'Hello',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
    await settle();

    expect(port.posted).toContainEqual({ status: 'done' });
  });
});

describe('the Origin-strip rule', () => {
  /** The rule the worker last handed to declarativeNetRequest. */
  function lastRule(): {
    condition: { urlFilter?: string; tabIds?: number[] };
    action: { requestHeaders?: { header: string; operation: string }[] };
  } | null {
    const call = sessionRules.mock.calls.at(-1)?.[0] as
      { addRules?: unknown[] } | undefined;
    return (call?.addRules?.[0] ?? null) as ReturnType<typeof lastRule>;
  }

  it('installs on load, so a fresh install needs no OLLAMA_ORIGINS', async () => {
    await settle();
    expect(sessionRules).toHaveBeenCalled();
    expect(lastRule()?.action.requestHeaders).toEqual([
      { header: 'origin', operation: 'remove' },
    ]);
    expect(lastRule()?.condition.urlFilter).toBe('|http://localhost:11434/');
  });

  it('never applies to a request that belongs to a tab', async () => {
    // Origin is what stops a web page from driving a local model. Only
    // tab-less requests — this extension's own — may have it stripped.
    await settle();
    expect(lastRule()?.condition.tabIds).toEqual([-1]);
  });

  it('follows the server when the user points somewhere else', async () => {
    mocks.loadSettings.mockResolvedValue({ baseUrl: 'http://nas.local:11434' });
    registered.onStorageChanged({ baseUrl: { newValue: 'x' } }, 'sync');
    await settle();
    expect(lastRule()?.condition.urlFilter).toBe('|http://nas.local:11434/');
  });

  it('ignores changes to settings that are not the server URL', async () => {
    await settle();
    const before = sessionRules.mock.calls.length;
    registered.onStorageChanged({ targetLang: { newValue: 'x' } }, 'sync');
    await settle();
    expect(sessionRules.mock.calls.length).toBe(before);
  });

  it('ignores writes to a storage area this extension does not use', async () => {
    await settle();
    const before = sessionRules.mock.calls.length;
    registered.onStorageChanged({ baseUrl: { newValue: 'x' } }, 'local');
    await settle();
    expect(sessionRules.mock.calls.length).toBe(before);
  });

  it('installs nothing rather than something malformed', async () => {
    mocks.loadSettings.mockResolvedValue({ baseUrl: 'not a url' });
    registered.onStorageChanged({ baseUrl: { newValue: 'x' } }, 'sync');
    await settle();
    const call = sessionRules.mock.calls.at(-1)?.[0] as { addRules: unknown[] };
    expect(call.addRules).toEqual([]);
  });

  it('always clears the previous rule, so rules cannot stack', async () => {
    await settle();
    const call = sessionRules.mock.calls.at(-1)?.[0] as {
      removeRuleIds: number[];
    };
    expect(call.removeRuleIds).toEqual([1]);
  });
});

describe('the right-click menu', () => {
  it('offers an item for a selection, the page, and a text box', () => {
    // Whole-page translation shipped reachable only from a toolbar popup and
    // a keyboard shortcut. A user with it installed opened the context menu,
    // found Chrome's own translate item and not this one, and asked where the
    // feature had gone.
    expect(
      createdMenus
        .map((m) => m.contexts)
        .flat()
        .sort(),
    ).toEqual(['editable', 'page', 'selection']);
    for (const item of createdMenus) {
      expect(item.title).toContain('OpenRead');
    }
  });

  it('translates the page when the page item is clicked', () => {
    const page = createdMenus.find((m) => m.contexts.includes('page'));
    menuClick({ menuItemId: page!.id }, { id: 7 });
    expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: 'TRANSLATE_PAGE' });
  });

  it('translates the selection when the selection item is clicked', () => {
    const sel = createdMenus.find((m) => m.contexts.includes('selection'));
    menuClick({ menuItemId: sel!.id }, { id: 7 });
    expect(tabsSendMessage).toHaveBeenCalledWith(7, {
      type: 'TRANSLATE_SELECTION',
    });
  });

  it('ignores a click with no tab, and an id that is not ours', () => {
    menuClick({ menuItemId: 'openread-translate-page' }, undefined);
    menuClick({ menuItemId: 'someone-elses-item' }, { id: 7 });
    expect(tabsSendMessage).not.toHaveBeenCalled();
  });

  it('rebuilds the menu rather than adding to it', () => {
    // The worker restarts at any time, and `create` on an existing id errors.
    const before = createdMenus.length;
    registered.onInstalled();
    expect(createdMenus.length).toBe(before);
  });
});
