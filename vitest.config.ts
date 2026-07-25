import { defineConfig } from 'vitest/config';

// The pure core under src/core is framework-free, so tests run in a plain Node
// environment with no WXT setup; the selection controller opts into jsdom with
// a per-file `@vitest-environment` pragma. Coverage covers the core plus the
// selection UI — the entrypoints are thin wiring, exercised by manual/e2e paths.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts', 'src/ui/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
