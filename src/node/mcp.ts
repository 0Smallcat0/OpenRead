/**
 * An MCP server, so an agent can use the pipeline the way a person can.
 *
 * `openread mcp` speaks JSON-RPC 2.0 over stdio and exposes two tools. Point
 * any MCP client at it and translation becomes something a model can call,
 * running entirely on the user's machine — which is the same property that
 * makes the extension worth having, applied to the agent case.
 *
 * Hand-rolled rather than built on the official SDK, for two reasons that both
 * matter here. The protocol surface a stdio tool server needs is small enough
 * to read in one sitting — five methods — and a project whose argument is that
 * its claims are checkable is better served by a handshake it can test than by
 * a dependency it has to trust. The test spawns this file and performs a real
 * initialize / tools/list / tools/call exchange.
 *
 * A note on framing: this speaks newline-delimited JSON. `Content-Length`
 * framing belongs to LSP and to MCP's HTTP transport, not to stdio.
 */
import { createInterface } from 'node:readline';
import { translate, listModels } from './translate';
import { DEFAULTS, type Config } from './config';

/** Revisions this server implements. The newest is offered by default. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'translate',
    description:
      'Translate text with a local LLM through Ollama. Runs entirely on this ' +
      'machine — nothing is sent to a cloud service. Output is passed through ' +
      "OpenRead's reliability layer, which strips model preamble, thinking, " +
      'echoed input and quote wrapping, and converts Simplified to Taiwan-' +
      'convention Traditional Chinese when the target calls for it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to translate.' },
        targetLang: {
          type: 'string',
          description: `Target language. Defaults to ${DEFAULTS.targetLang}.`,
        },
        model: {
          type: 'string',
          description: `Ollama model. Defaults to ${DEFAULTS.model}.`,
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_models',
    description:
      'List the models the local Ollama server has available, so a translate ' +
      'call can name one that exists rather than failing mid-generation.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id: Request['id'], result: unknown): void {
  write({ jsonrpc: '2.0', id, result });
}

function fail(id: Request['id'], code: number, message: string): void {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

/** A tool failure is a result with `isError`, not a JSON-RPC error. */
function toolResult(text: string, isError = false): unknown {
  return { content: [{ type: 'text', text }], isError };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  config: Config,
): Promise<unknown> {
  if (name === 'list_models') {
    const models = await listModels(config.baseUrl);
    return toolResult(
      models.length > 0 ? models.join('\n') : 'No models installed.',
    );
  }

  if (name !== 'translate') {
    return toolResult(`Unknown tool: ${name}`, true);
  }

  const text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) return toolResult('`text` is required.', true);

  const translated = await translate({
    text,
    targetLang:
      typeof args.targetLang === 'string' && args.targetLang
        ? args.targetLang
        : config.targetLang,
    model:
      typeof args.model === 'string' && args.model ? args.model : config.model,
    baseUrl: config.baseUrl,
  });
  return toolResult(translated);
}

export function runMcpServer(config: Config, version: string): void {
  const lines = createInterface({ input: process.stdin });

  // A tool call is answered asynchronously, so exiting the moment stdin closes
  // truncates whatever was still generating. A long-lived client never
  // triggers this, but anything that pipes a batch of requests in does — and
  // silently dropping the last answer is the worst way to fail.
  let inFlight = 0;
  let closed = false;
  const exitWhenDrained = (): void => {
    if (closed && inFlight === 0) process.exit(0);
  };

  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: Request;
    try {
      request = JSON.parse(trimmed) as Request;
    } catch {
      fail(null, -32700, 'Parse error');
      return;
    }

    // A notification has no id and must never be answered — replying to
    // `notifications/initialized` is the classic way to wedge a client.
    const isNotification = request.id === undefined;

    inFlight++;
    void (async () => {
      try {
        switch (request.method) {
          case 'initialize': {
            const asked = request.params?.protocolVersion;
            ok(request.id, {
              protocolVersion:
                typeof asked === 'string' && SUPPORTED_PROTOCOLS.includes(asked)
                  ? asked
                  : SUPPORTED_PROTOCOLS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'openread', version },
            });
            return;
          }
          case 'tools/list':
            ok(request.id, { tools: TOOLS });
            return;
          case 'tools/call': {
            const name = String(request.params?.name ?? '');
            const args = (request.params?.arguments ?? {}) as Record<
              string,
              unknown
            >;
            ok(request.id, await callTool(name, args, config));
            return;
          }
          case 'ping':
            ok(request.id, {});
            return;
          default:
            if (!isNotification) {
              fail(request.id, -32601, `Method not found: ${request.method}`);
            }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Reaching Ollama is the failure a caller can act on, and a model
        // reads a tool result where it would never see a transport error.
        if (!isNotification) ok(request.id, toolResult(message, true));
      } finally {
        inFlight--;
        exitWhenDrained();
      }
    })();
  });

  lines.on('close', () => {
    closed = true;
    exitWhenDrained();
  });
}
