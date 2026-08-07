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
}));

vi.mock('../src/api/ollama', () => ({
  translateStream: mocks.translateStream,
  enrichText: mocks.enrichText,
}));
vi.mock('../src/settings', () => ({ loadSettings: mocks.loadSettings }));

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
    sender: { tab?: { id?: number } },
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

/** Let the worker's awaited `loadSettings()` and stream call resolve. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  mocks.translateStream.mockReset();
  mocks.enrichText.mockReset();
  mocks.loadSettings.mockReset().mockResolvedValue({ baseUrl: BASE_URL });
  fileSchemeAllowed = true;
  tabsUpdate = vi.fn().mockResolvedValue(undefined);
  tabsQuery = vi.fn().mockResolvedValue([{ id: 7 }]);
  tabsSendMessage = vi.fn().mockResolvedValue(undefined);
  sessionRules = vi.fn().mockResolvedValue(undefined);
  createdMenus = [];
  menuClick = () => undefined;
  startupListeners = [];
  installedListeners = [];

  const partial: Partial<Registered> = {};
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: () => VIEWER,
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
