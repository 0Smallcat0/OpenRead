/**
 * Bundle the CLI and MCP server into dist/.
 *
 * esbuild rather than `tsc -p`, for one concrete reason. The extension's source
 * uses extensionless relative imports, which is correct for a bundled target
 * and rejected by TypeScript's NodeNext resolution. Emitting with `tsc` would
 * mean rewriting every import in `src/core` to carry a `.js` suffix — churning
 * the whole codebase so that one entry point could be published.
 *
 * Bundling also decides the `opencc-js` question the right way: its Simplified
 * → Traditional phrase dictionaries come along in the output, so `npx openread`
 * works on a machine with nothing installed, which is the entire point of
 * offering it.
 *
 * Only what the CLI entry actually reaches is included, which is why the
 * browser-only modules — `ui/`, `entrypoints/`, `core/dnr-rule.ts` and its
 * `chrome` namespace — never appear here and need no exclusion list.
 */
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/node/cli.ts'],
  outfile: 'dist/node/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Keeps the published package honest about what it actually ships.
  metafile: true,
  logLevel: 'info',
});

const output = result.metafile.outputs['dist/node/cli.js'];
console.log(`dist/node/cli.js  ${(output.bytes / 1024).toFixed(0)} kB`);
