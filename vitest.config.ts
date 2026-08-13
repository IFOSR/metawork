import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Session acceptance tests perform real workspace/git operations. Running
    // them in parallel across workers starves those operations and produces
    // intermittent timeouts, so test files run serially with a generous timeout.
    fileParallelism: false,
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/storage/**'],
    },
  },
});
