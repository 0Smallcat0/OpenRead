/**
 * The MCP server, driven the way a client drives it.
 *
 * This spawns the published entry point — `bin/openread.mjs`, running the
 * bundle in `dist/` — and performs a real JSON-RPC exchange over stdio. The
 * point is that the protocol is asserted rather than assumed: the server is
 * hand-rolled, so the argument for not depending on the official SDK is only
 * honest if the handshake is actually tested.
 *
 * Deliberately no Ollama. Everything here is protocol behaviour, plus the one
 * path that matters when the server is not running: a tool failure has to come
 * back as a result with `isError`, because that is what a model can read and
 * act on. A JSON-RPC error would surface to the client as a broken tool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface, type Interface } from 'node:readline';

const BIN = fileURLToPath(new URL('../bin/openread.mjs', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/node/cli.js', import.meta.url));

interface Response {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let server: ChildProcessWithoutNullStreams;
let lines: Interface;
const pending = new Map<number, (response: Response) => void>();
const unsolicited: Response[] = [];

/** Send a request and wait for the reply carrying its id. */
function call(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    );
  });
}

/** Send a notification, which by definition gets no reply. */
function notify(method: string): void {
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

beforeAll(() => {
  if (!existsSync(DIST)) {
    throw new Error(
      `No bundle at ${DIST}. Run \`pnpm build:cli\` before \`pnpm test\`.`,
    );
  }
  server = spawn(process.execPath, [BIN, 'mcp'], {
    // A port nothing is listening on, so a tool call fails the way it would
    // on a machine where Ollama is not running.
    env: { ...process.env, OPENREAD_URL: 'http://127.0.0.1:1' },
    stdio: 'pipe',
  });
  lines = createInterface({ input: server.stdout });
  lines.on('line', (line) => {
    const response = JSON.parse(line) as Response;
    const resolve =
      response.id === undefined ? undefined : pending.get(response.id);
    if (resolve) {
      pending.delete(response.id as number);
      resolve(response);
    } else {
      unsolicited.push(response);
    }
  });
});

afterAll(() => {
  lines.close();
  server.kill();
});

describe('the MCP server', () => {
  it('completes the initialize handshake', async () => {
    const response = await call(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'openread-tests', version: '0' },
    });
    expect(response.result?.protocolVersion).toBe('2025-06-18');
    expect(response.result?.capabilities).toHaveProperty('tools');
    expect(response.result?.serverInfo).toMatchObject({ name: 'openread' });
  });

  it('falls back to its newest revision when asked for one it does not know', async () => {
    const response = await call(2, 'initialize', {
      protocolVersion: '1999-01-01',
      capabilities: {},
    });
    expect(response.result?.protocolVersion).toBe('2025-06-18');
  });

  it('never answers a notification', async () => {
    // Replying to `notifications/initialized` is the classic way to wedge a
    // client that is waiting on its own next request.
    notify('notifications/initialized');
    await call(3, 'ping');
    expect(unsolicited).toEqual([]);
  });

  it('advertises both tools with usable schemas', async () => {
    const response = await call(4, 'tools/list');
    const tools = response.result?.tools as {
      name: string;
      description: string;
      inputSchema: { required?: string[] };
    }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'list_models',
      'translate',
    ]);
    const translate = tools.find((tool) => tool.name === 'translate');
    expect(translate?.inputSchema.required).toEqual(['text']);
    // The description is what a model reads to decide whether to call this.
    expect(translate?.description).toContain('local');
  });

  it('answers ping, which is how a client checks the server is alive', async () => {
    expect((await call(5, 'ping')).result).toEqual({});
  });

  it('reports an unknown method as a JSON-RPC error', async () => {
    const response = await call(6, 'resources/list');
    expect(response.error?.code).toBe(-32601);
  });

  it('rejects an empty translate call before touching the network', async () => {
    const response = await call(7, 'tools/call', {
      name: 'translate',
      arguments: { text: '   ' },
    });
    expect(response.result?.isError).toBe(true);
  });

  it('returns an unreachable server as a readable tool error', async () => {
    // Not a JSON-RPC error: a model can read a tool result and tell the user
    // to start Ollama. A transport error just looks like a broken tool.
    const response = await call(8, 'tools/call', {
      name: 'translate',
      arguments: { text: 'Hello, world.' },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.error).toBeUndefined();
    const content = response.result?.content as { text: string }[];
    expect(content[0]?.text).toBeTruthy();
  });

  it('names an unknown tool instead of failing silently', async () => {
    const response = await call(9, 'tools/call', {
      name: 'summarise',
      arguments: {},
    });
    expect(response.result?.isError).toBe(true);
    const content = response.result?.content as { text: string }[];
    expect(content[0]?.text).toContain('summarise');
  });

  it('survives a malformed line rather than dying on it', async () => {
    server.stdin.write('this is not json\n');
    expect((await call(10, 'ping')).result).toEqual({});
  });

  it('finishes in-flight work before exiting on a closed stdin', async () => {
    // Piping a batch of requests closes stdin immediately. Exiting on that
    // event drops whatever was still generating — the last answer, silently.
    const batch = spawn(process.execPath, [BIN, 'mcp'], {
      env: { ...process.env, OPENREAD_URL: 'http://127.0.0.1:1' },
      stdio: 'pipe',
    });
    let out = '';
    batch.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    batch.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_models', arguments: {} },
      })}\n`,
    );
    batch.stdin.end();

    await new Promise((resolve) => batch.on('exit', resolve));
    expect(out).toContain('"id":1');
  });
});
