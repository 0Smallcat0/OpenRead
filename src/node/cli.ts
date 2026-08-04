/**
 * `openread` — the pipeline as a Unix filter.
 *
 * Text on stdin or in an argument, translated text on stdout. No browser, no
 * extension, no clicking. That makes it usable from a shell, a Makefile, a
 * pipe, and — through `openread mcp` — from an agent.
 *
 * Streams to stdout by default, because a local model on a long input is slow
 * enough that watching it arrive is worth more than atomicity. `--quiet`
 * buffers instead, for the case where the output is being captured.
 */
import { readFile } from 'node:fs/promises';
import { translate, listModels } from './translate';
import { resolveConfig, DEFAULTS, type Config } from './config';
import { runMcpServer } from './mcp';

export interface ParsedArgs {
  command: 'translate' | 'models' | 'mcp' | 'help' | 'version';
  text?: string;
  file?: string;
  flags: Partial<Config>;
  stream: boolean;
  error?: string;
}

const USAGE = `openread — translate with a local LLM through Ollama

USAGE
  openread <text>                 translate an argument
  cat file.txt | openread         translate stdin
  openread -f notes.md            translate a file
  openread models                 list what the local server has
  openread mcp                    run as an MCP server over stdio

OPTIONS
  -t, --to <language>   target language        (default: ${DEFAULTS.targetLang})
  -m, --model <name>    Ollama model           (default: ${DEFAULTS.model})
  -u, --url <url>       Ollama server          (default: ${DEFAULTS.baseUrl})
  -f, --file <path>     read the input from a file
  -q, --quiet           buffer instead of streaming to stdout
  -h, --help            this text
  -V, --version         print the version

ENVIRONMENT
  OPENREAD_URL, OPENREAD_MODEL, OPENREAD_LANG, OLLAMA_HOST

Everything runs on this machine. Nothing is sent to a cloud service.`;

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: 'translate',
    flags: {},
    stream: true,
  };
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    const takeValue = (): string | undefined => argv[++i];

    switch (arg) {
      case '-h':
      case '--help':
        result.command = 'help';
        return result;
      case '-V':
      case '--version':
        result.command = 'version';
        return result;
      case '-q':
      case '--quiet':
        result.stream = false;
        break;
      case '-t':
      case '--to': {
        const value = takeValue();
        if (!value) return { ...result, error: `${arg} needs a language` };
        result.flags.targetLang = value;
        break;
      }
      case '-m':
      case '--model': {
        const value = takeValue();
        if (!value) return { ...result, error: `${arg} needs a model name` };
        result.flags.model = value;
        break;
      }
      case '-u':
      case '--url': {
        const value = takeValue();
        if (!value) return { ...result, error: `${arg} needs a URL` };
        result.flags.baseUrl = value;
        break;
      }
      case '-f':
      case '--file': {
        const value = takeValue();
        if (!value) return { ...result, error: `${arg} needs a path` };
        result.file = value;
        break;
      }
      default:
        // An unknown flag is a typo, not text to translate. Treating
        // `--modle qwen3` as input would silently translate the word.
        if (arg.startsWith('-') && arg !== '-') {
          return { ...result, error: `Unknown option: ${arg}` };
        }
        words.push(arg);
    }
  }

  const first = words[0];
  if (first === 'mcp' || first === 'models') {
    result.command = first;
    return result;
  }
  if (words.length > 0) result.text = words.join(' ');
  return result;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: string[], version: string): Promise<number> {
  const args = parseArgs(argv);

  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const config = resolveConfig(args.flags);

  if (args.command === 'mcp') {
    runMcpServer(config, version);
    return -1; // Long-running: the caller must not exit.
  }

  try {
    if (args.command === 'models') {
      const models = await listModels(config.baseUrl);
      process.stdout.write(`${models.join('\n')}\n`);
      return 0;
    }

    const text = args.file
      ? await readFile(args.file, 'utf8')
      : (args.text ?? (await readStdin()));

    if (!text.trim()) {
      process.stderr.write(`Nothing to translate.\n\n${USAGE}\n`);
      return 2;
    }

    const output = await translate({
      text: text.trim(),
      targetLang: config.targetLang,
      model: config.model,
      baseUrl: config.baseUrl,
      onChunk: args.stream ? (chunk) => process.stdout.write(chunk) : undefined,
    });

    if (args.stream) {
      process.stdout.write('\n');
    } else {
      process.stdout.write(`${output}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}
