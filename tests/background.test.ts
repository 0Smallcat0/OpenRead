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
      onStartup: {
        addListener: (fn: Registered['onStartup']) => {
          partial.onStartup = fn;
        },
      },
      onInstalled: {
        addListener: (fn: Registered['onInstalled']) => {
          partial.onInstalled = fn;
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
  });
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
    expect(error.message).toContain('OLLAMA_ORIGINS');
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
  it('opens a local PDF in the viewer when file access is granted', async () => {
    const sendResponse = vi.fn();
    const kept = registered.onMessage(
      { type: 'OPEN_PDF_VIEWER', url: 'file:///C:/a.pdf' },
      { tab: { id: 9 } },
      sendResponse,
    );
    await settle();

    expect(kept).toBe(true); // channel held open for the async reply
    expect(tabsUpdate).toHaveBeenCalledWith(9, {
      url: `${VIEWER}?file=${encodeURIComponent('file:///C:/a.pdf')}`,
    });
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('reports the missing permission instead of silently doing nothing', async () => {
    fileSchemeAllowed = false;
    const sendResponse = vi.fn();
    registered.onMessage(
      { type: 'OPEN_PDF_VIEWER', url: 'file:///C:/a.pdf' },
      { tab: { id: 9 } },
      sendResponse,
    );
    await settle();

    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ error: 'PERMISSION_DENIED' });
  });

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

  it('does not hold the channel open for a message it does not handle', () => {
    expect(
      registered.onMessage({ type: 'SOMETHING_ELSE' }, {}, vi.fn()),
    ).toBeUndefined();
  });
});
