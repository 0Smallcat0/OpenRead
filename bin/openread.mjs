#!/usr/bin/env node
/**
 * The `openread` entry point.
 *
 * Deliberately tiny and plain JavaScript: it is the file npm makes executable,
 * so it must run with no build step of its own and no runtime dependency on
 * TypeScript. Everything else lives in dist/, compiled by `pnpm build:cli`.
 */
import { readFileSync } from 'node:fs';
import { main } from '../dist/node/cli.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const code = await main(process.argv.slice(2), version);

// `mcp` returns -1: it owns stdio until the client closes it, and exiting here
// would kill the server the moment it finished starting.
if (code >= 0) process.exit(code);
