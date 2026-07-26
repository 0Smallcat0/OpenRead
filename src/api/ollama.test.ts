import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractChunk, translateStream } from './ollama';

describe('extractChunk', () => {
  it('extracts content from a native NDJSON line', () => {
    const line =
      '{"message":{"role":"assistant","content":"你好"},"done":false}';
    expect(extractChunk(line)).toEqual({
      content: '你好',
      thinking: '',
      done: false,
      evalCount: undefined,
    });
  });

  it('keeps thinking separate from content', () => {
    const line =
      '{"message":{"role":"assistant","content":"","thinking":"Let me see"},"done":false}';
    expect(extractChunk(line)).toEqual({
      content: '',
      thinking: 'Let me see',
      done: false,
      evalCount: undefined,
    });
  });

  it('surfaces the token count on the done chunk', () => {
    const line =
      '{"message":{"role":"assistant","content":""},"done":true,"eval_count":42}';
    expect(extractChunk(line)).toEqual({
      content: '',
      thinking: '',
      done: true,
      evalCount: 42,
    });
  });

  it('returns null for blank lines', () => {
    expect(extractChunk('')).toBeNull();
    expect(extractChunk('   ')).toBeNull();
  });

  it('swallows malformed JSON rather than throwing', () => {
    expect(extractChunk('{not json')).toBeNull();
  });
});

/** Build a Response whose body streams the given NDJSON text chunks. */
function ndjsonResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function ndjsonLine(content: string, done = false): string {
  return `${JSON.stringify({ message: { role: 'assistant', content }, done })}\n`;
}

const BASE_URL = 'http://localhost:11434';

describe('translateStream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('assembles cleaned chunks from an NDJSON stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ndjsonResponse([
            ndjsonLine('你好'),
            ndjsonLine('，世界'),
            ndjsonLine('！這是測試'),
            ndjsonLine('', true),
          ]),
        ),
    );

    const chunks: string[] = [];
    await translateStream({
      text: 'Hello, world! This is a test',
      baseUrl: BASE_URL,
      model: 'qwen2.5',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks.join('')).toBe('你好，世界！這是測試');
  });

  it('requests the native endpoint with thinking disabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ndjsonResponse([ndjsonLine('你好', true)]));
    vi.stubGlobal('fetch', fetchMock);

    await translateStream({
      text: 'Hello',
      baseUrl: BASE_URL,
      model: 'qwen3:latest',
      targetLang: 'Traditional Chinese',
      onChunk: () => {},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/api/chat`,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse((init?.body as string) ?? '{}') as {
      think?: boolean;
      stream?: boolean;
    };
    expect(body.think).toBe(false);
    expect(body.stream).toBe(true);
  });

  it('never emits thinking-only chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          `${JSON.stringify({
            message: { role: 'assistant', content: '', thinking: '推理中……' },
            done: false,
          })}\n`,
          ndjsonLine('你好世界'),
          ndjsonLine('', true),
        ]),
      ),
    );

    const chunks: string[] = [];
    await translateStream({
      text: 'Hello world',
      baseUrl: BASE_URL,
      model: 'deepseek-r1:8b',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks.join('')).toBe('你好世界');
  });

  it('strips a leading preamble emitted over the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ndjsonResponse([
            ndjsonLine('Sure, here is the translation:\n'),
            ndjsonLine('你好世界'),
            ndjsonLine('', true),
          ]),
        ),
    );

    const chunks: string[] = [];
    await translateStream({
      text: 'Hello world',
      baseUrl: BASE_URL,
      model: 'qwen2.5',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks.join('')).toBe('你好世界');
  });

  it('converts Simplified output to Traditional for a Traditional target', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          ndjsonResponse([
            ndjsonLine('鼠标和软件都很好用啊'),
            ndjsonLine('', true),
          ]),
        ),
    );

    const chunks: string[] = [];
    await translateStream({
      text: 'The mouse and software are great',
      baseUrl: BASE_URL,
      model: 'qwen2.5',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks.join('')).toBe('滑鼠和軟體都很好用啊');
  });

  it('throws on a non-OK response with a native string error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'model not found' }), {
          status: 404,
        }),
      ),
    );

    await expect(
      translateStream({
        text: 'Hello',
        baseUrl: BASE_URL,
        model: 'missing-model',
        targetLang: 'English',
        onChunk: () => {},
      }),
    ).rejects.toThrow('Ollama 404: model not found');
  });

  it('explains a 403 instead of reporting an empty body', async () => {
    // Measured against the real extension: Ollama refuses a chrome-extension://
    // origin with 403 and no body, which used to surface as "Ollama 403: {}".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 403 })),
    );

    await expect(
      translateStream({
        text: 'Hello',
        baseUrl: BASE_URL,
        model: 'qwen3',
        targetLang: 'Traditional Chinese',
        onChunk: () => {},
      }),
    ).rejects.toThrow(/OLLAMA_ORIGINS/);
  });

  it('gives up when the server accepts the request and then goes silent', async () => {
    // A wedged model load looks exactly like this from the client: headers
    // arrive, then nothing. Without a bound the panel sits on "Translating…"
    // for the lifetime of the service worker.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start() {
              /* never enqueues, never closes */
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      translateStream({
        text: 'Hello',
        baseUrl: BASE_URL,
        model: 'qwen3',
        targetLang: 'Traditional Chinese',
        timeoutMs: 20,
        onChunk: () => {},
      }),
    ).rejects.toThrow(/sent nothing for .* streaming the translation/);
  });

  it('gives up when the server never sends response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise(() => undefined)),
    );

    await expect(
      translateStream({
        text: 'Hello',
        baseUrl: BASE_URL,
        model: 'qwen3',
        targetLang: 'Traditional Chinese',
        timeoutMs: 20,
        onChunk: () => {},
      }),
    ).rejects.toThrow(/sent nothing for .* opening the stream/);
  });

  it('resets the idle budget on every chunk, so a slow stream is not cut off', async () => {
    // Three chunks, each arriving just inside the window: the total run exceeds
    // the timeout but no single gap does.
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (sent === 3) controller.close();
            else
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ message: { content: '字' }, done: false })}\n`,
                ),
              );
            sent++;
            resolve();
          }, 30);
        });
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
    );

    const chunks: string[] = [];
    await translateStream({
      text: 'Hello',
      baseUrl: BASE_URL,
      model: 'qwen3',
      targetLang: 'Traditional Chinese',
      timeoutMs: 80,
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks.join('')).toBe('字字字');
  });
});
