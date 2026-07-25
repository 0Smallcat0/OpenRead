import { defineConfig } from 'vitest/config';

// The pure core under src/core is framework-free, so tests run in a plain Node
// environment with no WXT setup; the UI files opt into jsdom with a per-file
// `@vitest-environment` pragma. Coverage spans everything with real behaviour:
// the core, the selection and capture UI, and the background worker (which owns
// cancellation, error translation and PDF routing). The remaining entrypoints
// are a few lines of mounting each.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'eval/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/ui/**/*.ts',
        'src/entrypoints/background.ts',
      ],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
