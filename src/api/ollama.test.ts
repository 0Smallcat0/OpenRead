import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractDelta, translateStream } from './ollama';

describe('extractDelta', () => {
  it('extracts delta content from a data line', () => {
    const line = 'data: {"choices":[{"delta":{"content":"你好"}}]}';
    expect(extractDelta(line)).toBe('你好');
  });

  it('returns null for the [DONE] sentinel and keep-alives', () => {
    expect(extractDelta('data: [DONE]')).toBeNull();
    expect(extractDelta(': keep-alive')).toBeNull();
    expect(extractDelta('')).toBeNull();
  });

  it('returns null for a role-only opening delta', () => {
    expect(
      extractDelta('data: {"choices":[{"delta":{"role":"assistant"}}]}'),
    ).toBeNull();
  });

  it('swallows malformed JSON rather than throwing', () => {
    expect(extractDelta('data: {not json')).toBeNull();
  });
});

/** Build a Response whose body streams the given SSE text as one or more chunks. */
function sseResponse(sseChunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function sseLine(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

const BASE_URL = 'http://localhost:11434';

describe('translateStream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('assembles cleaned chunks from an SSE stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            sseLine('你好'),
            sseLine('，世界'),
            sseLine('！這是測試'),
            'data: [DONE]\n',
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

  it('strips a leading preamble emitted over the stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            sseLine('Sure, here is the translation:\n'),
            sseLine('你好世界'),
            'data: [DONE]\n',
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
          sseResponse([sseLine('鼠标和软件都很好用啊'), 'data: [DONE]\n']),
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

  it('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'model not found' } }),
          {
            status: 404,
          },
        ),
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
});
