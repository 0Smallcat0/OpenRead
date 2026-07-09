import { defineConfig } from 'vitest/config';

// The pure core under src/core is framework-free, so tests run in a plain Node
// environment with no WXT/DOM setup. Coverage is scoped to the tested core —
// entrypoints are exercised by manual/e2e paths, not unit tests.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/*.test.ts'],
    },
  },
});
