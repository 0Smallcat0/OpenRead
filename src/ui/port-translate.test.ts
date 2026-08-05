// @vitest-environment jsdom
/**
 * The whole-page queue is only as reliable as this promise. A request that
 * never settles does not fail loudly — it holds one of two worker slots
 * forever and the page silently stops filling, which is the failure mode these
 * tests exist to make impossible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { translateViaPort } from './port-translate';
import { STREAM_PORT_NAME, type StreamResponse } from '../messaging';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (r: StreamResponse) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

let port: FakePort;
let emit: (response: StreamResponse) => void;
let dropConnection: () => void;
let connectName: string | undefined;

beforeEach(() => {
  emit = () => undefined;
  dropConnection = () => undefined;
  connectName = undefined;
  port = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: (fn) => {
        emit = fn;
      },
    },
    onDisconnect: {
      addListener: (fn) => {
        dropConnection = fn;
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      connect: (info: { name: string }) => {
        connectName = info.name;
        return port;
      },
    },
  };
});

function start(signal = new AbortController().signal): Promise<string> {
  return translateViaPort({
    text: 'The first paragraph.',
    targetLang: 'Traditional Chinese',
    model: 'qwen3:latest',
    signal,
  });
}

describe('translateViaPort', () => {
  it('joins the stream into one string and closes the port', async () => {
    const promise = start();
    emit({ status: 'streaming', chunk: '第一段' });
    emit({ status: 'streaming', chunk: '落。' });
    emit({ status: 'done' });

    await expect(promise).resolves.toBe('第一段落。');
    expect(connectName).toBe(STREAM_PORT_NAME);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('sends the block through the same broker selection uses', async () => {
    const promise = start();
    emit({ status: 'done' });
    await promise;
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'START_STREAM',
      text: 'The first paragraph.',
      targetLang: 'Traditional Chinese',
      model: 'qwen3:latest',
    });
  });

  it('reports a language-pack download without settling', async () => {
    // The first use of a language pair is roughly two minutes. Without this
    // the promise just sits there and the UI says nothing, which is how
    // switching target language came to look like a broken extension.
    const seen: number[] = [];
    const promise = translateViaPort({
      text: 'The first paragraph.',
      targetLang: 'Japanese',
      model: 'qwen3:latest',
      signal: new AbortController().signal,
      onDownloadProgress: (loaded) => seen.push(loaded),
    });
    emit({ status: 'downloading', loaded: 0.25 });
    emit({ status: 'downloading', loaded: 1 });
    expect(seen).toEqual([0.25, 1]);
    expect(port.disconnect).not.toHaveBeenCalled();

    emit({ status: 'streaming', chunk: '第一段。' });
    emit({ status: 'done' });
    await expect(promise).resolves.toBe('第一段。');
  });

  it('rejects on a broker error', async () => {
    const promise = start();
    emit({ status: 'error', message: 'Ollama refused this extension (403).' });
    await expect(promise).rejects.toThrow('403');
  });

  it('rejects when the worker dies instead of hanging forever', async () => {
    // An MV3 worker can be killed mid-generation. Without this listener the
    // promise never settles and the page stops filling with no error anywhere.
    const promise = start();
    dropConnection();
    await expect(promise).rejects.toThrow('disconnected');
  });

  it('rejects when the run is stopped mid-translation', async () => {
    const controller = new AbortController();
    const promise = start(controller.signal);
    emit({ status: 'streaming', chunk: '第一' });
    controller.abort();
    await expect(promise).rejects.toThrow('aborted');
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('does not open a port for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(start(controller.signal)).rejects.toThrow('aborted');
    expect(connectName).toBeUndefined();
  });

  it('ignores a late disconnect after a completed translation', async () => {
    const promise = start();
    emit({ status: 'done' });
    await expect(promise).resolves.toBe('');
    // Settling twice would turn a success into an unhandled rejection.
    expect(() => {
      dropConnection();
    }).not.toThrow();
  });
});
