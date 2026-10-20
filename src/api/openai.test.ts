import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractSseChunk,
  describeApiError,
  retryDelayMs,
  translateStreamOpenAI,
  MAX_RATE_RETRIES,
} from './openai';
import { normalizeApiBase, probeApi } from './probe';

describe('extractSseChunk', () => {
  it('takes the content delta from a data line', () => {
    const line =
      'data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}';
    expect(extractSseChunk(line)).toEqual({ content: '你好', done: false });
  });

  it('accepts a data line without the space some servers leave out', () => {
    expect(
      extractSseChunk('data:{"choices":[{"delta":{"content":"a"}}]}'),
    ).toEqual({ content: 'a', done: false });
  });

  it('ends on [DONE]', () => {
    expect(extractSseChunk('data: [DONE]')).toEqual({
      content: '',
      done: true,
    });
  });

  it('drops reasoning so it never reaches the reader', () => {
    const line =
      'data: {"choices":[{"delta":{"content":null,"reasoning_content":"Let me think"}}]}';
    expect(extractSseChunk(line)).toEqual({ content: '', done: false });
  });

  it('ignores keep-alives, comments and event names', () => {
    expect(extractSseChunk('')).toBeNull();
    expect(extractSseChunk(': OPENROUTER PROCESSING')).toBeNull();
    expect(extractSseChunk('event: message')).toBeNull();
  });

  it('reports an error sent inside a 200 stream', () => {
    const line =
      'data: {"error":{"message":"Provider returned error","code":502}}';
    expect(extractSseChunk(line)).toEqual({
      content: '',
      done: true,
      error: 'Provider returned error',
    });
  });

  it('swallows a malformed payload rather than throwing', () => {
    expect(extractSseChunk('data: {not json')).toBeNull();
  });
});

describe('describeApiError', () => {
  it('tells a user with no key to paste one, not that the key is wrong', () => {
    expect(describeApiError(401, '', 'api.openai.com', false)).toMatch(
      /needs an API key/,
    );
    expect(describeApiError(401, '', 'api.openai.com', true)).toMatch(
      /rejected the API key/,
    );
  });

  it("keeps the provider's own words", () => {
    expect(
      describeApiError(
        429,
        'You exceeded your current quota',
        'api.openai.com',
        true,
      ),
    ).toContain('You exceeded your current quota');
  });

  it('points a 404 at the model name and the address', () => {
    expect(describeApiError(404, '', 'api.deepseek.com', true)).toMatch(
      /model name.*\/v1/,
    );
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After in seconds', () => {
    expect(retryDelayMs('3', 0)).toBe(3000);
  });

  it('honours Retry-After as a date', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    expect(retryDelayMs('Wed, 21 Oct 2026 00:00:05 GMT', 0, now)).toBe(5000);
  });

  it('doubles when the server did not say', () => {
    expect([0, 1, 2].map((n) => retryDelayMs(null, n))).toEqual([
      1000, 2000, 4000,
    ]);
  });
});

describe('normalizeApiBase', () => {
  it('cuts a pasted full endpoint back to the base', () => {
    expect(normalizeApiBase('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1',
    );
    expect(normalizeApiBase(' https://openrouter.ai/api/v1/ ')).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(normalizeApiBase('http://localhost:1234/v1/models')).toBe(
      'http://localhost:1234/v1',
    );
  });
});

/** A Response whose body streams the given text chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function delta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function errorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers,
  });
}

const BASE = 'https://api.example.com/v1';

describe('translateStreamOpenAI', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('assembles a streamed answer and stops at [DONE]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          delta('你好'),
          delta('，世界'),
          // Split mid-line, the way a socket delivers it.
          'data: {"choices":[{"delta":{"con',
          'tent":"！"}}]}\n\n',
          'data: [DONE]\n\n',
          delta('after done'),
        ]),
      ),
    );
    const chunks: string[] = [];
    await translateStreamOpenAI({
      text: 'Hello, world!',
      baseUrl: BASE,
      apiKey: 'sk-test',
      model: 'some-model',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });
    expect(chunks.join('')).toBe('你好，世界！');
  });

  it('posts to chat/completions with the key, the model and the shipped prompt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse([delta('嗨'), 'data: [DONE]\n']));
    vi.stubGlobal('fetch', fetchMock);
    await translateStreamOpenAI({
      text: 'Hi',
      baseUrl: `${BASE}/chat/completions`,
      apiKey: ' sk-test ',
      model: 'some-model',
      targetLang: 'Traditional Chinese',
      onChunk: () => {},
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/chat/completions`,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    );
    const body = JSON.parse(init.body as string) as {
      model: string;
      stream: boolean;
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('some-model');
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.3);
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages.at(-1)?.content).toContain('Hi');
  });

  it('sends no Authorization header when there is no key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(sseResponse([delta('嗨'), 'data: [DONE]\n']));
    vi.stubGlobal('fetch', fetchMock);
    await translateStreamOpenAI({
      text: 'Hi',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: '',
      model: 'local-model',
      targetLang: 'Traditional Chinese',
      onChunk: () => {},
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('asks again without a temperature when the model refuses one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(
          400,
          "Unsupported value: 'temperature' does not support 0.3 with this model.",
        ),
      )
      .mockResolvedValueOnce(sseResponse([delta('嗨'), 'data: [DONE]\n']));
    vi.stubGlobal('fetch', fetchMock);
    const chunks: string[] = [];
    await translateStreamOpenAI({
      text: 'Hi',
      baseUrl: BASE,
      apiKey: 'sk-test',
      model: 'reasoning-model',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(second).not.toHaveProperty('temperature');
    expect(chunks.join('')).toBe('嗨');
  });

  it('waits out a rate limit the server names, then carries on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorResponse(429, 'slow down', { 'retry-after': '0' }),
      )
      .mockResolvedValueOnce(sseResponse([delta('嗨'), 'data: [DONE]\n']));
    vi.stubGlobal('fetch', fetchMock);
    const chunks: string[] = [];
    await translateStreamOpenAI({
      text: 'Hi',
      baseUrl: BASE,
      apiKey: 'sk-test',
      model: 'm',
      targetLang: 'Traditional Chinese',
      onChunk: (c) => chunks.push(c),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunks.join('')).toBe('嗨');
  });

  it('gives up on a rate limit after a bounded number of tries', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(errorResponse(429, 'quota', { 'retry-after': '0' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      translateStreamOpenAI({
        text: 'Hi',
        baseUrl: BASE,
        apiKey: 'sk-test',
        model: 'm',
        targetLang: 'Traditional Chinese',
        onChunk: () => {},
      }),
    ).rejects.toThrow(/429.*quota/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RATE_RETRIES + 1);
  });

  it('does not sit through a pause longer than a reader would wait', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(errorResponse(429, 'quota', { 'retry-after': '60' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      translateStreamOpenAI({
        text: 'Hi',
        baseUrl: BASE,
        apiKey: 'sk-test',
        model: 'm',
        targetLang: 'Traditional Chinese',
        onChunk: () => {},
      }),
    ).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the missing setting instead of sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      translateStreamOpenAI({
        text: 'Hi',
        baseUrl: BASE,
        apiKey: 'sk-test',
        model: '  ',
        targetLang: 'Traditional Chinese',
        onChunk: () => {},
      }),
    ).rejects.toThrow(/Choose a model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces an error the provider sent mid-stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            delta('你'),
            'data: {"error":{"message":"upstream timed out"}}\n\n',
          ]),
        ),
    );
    await expect(
      translateStreamOpenAI({
        text: 'Hi',
        baseUrl: BASE,
        apiKey: 'sk-test',
        model: 'm',
        targetLang: 'Traditional Chinese',
        onChunk: () => {},
      }),
    ).rejects.toThrow(/upstream timed out/);
  });

  it('stops waiting on a rate limit the moment the reader cancels', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(errorResponse(429, 'slow', { 'retry-after': '10' })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const run = translateStreamOpenAI({
      text: 'Hi',
      baseUrl: BASE,
      apiKey: 'sk-test',
      model: 'm',
      targetLang: 'Traditional Chinese',
      signal: controller.signal,
      onChunk: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('probeApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists the models the key can use, with the key sent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, {}] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeApi(`${BASE}/`, 'sk-test')).toEqual({
      kind: 'ok',
      models: ['model-a', 'model-b'],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/models`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('tells a rejected key apart from an unreachable server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    expect(await probeApi(BASE, 'bad')).toEqual({
      kind: 'unauthorized',
      status: 401,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    expect(await probeApi(BASE, 'k')).toEqual({ kind: 'unreachable' });
  });
});
