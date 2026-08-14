import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Bound worker parallelism so the cross-repository Pi tsx driver and other
    // real process/workspace tests do not starve each other for CPU.
    minWorkers: 1,
    maxWorkers: 6,
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/storage/**'],
    },
  },
});
