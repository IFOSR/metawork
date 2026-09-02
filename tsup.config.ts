import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/install-cli.ts',
    'src/planner-mcp.ts',
    'src/generate-planner-schema.ts',
    'src/capability-request-cli.ts',
    'src/capability-use-cli.ts',
    'src/image-api-cli.ts',
    'src/emit-pi-attempt-extension.ts',
    'src/prepare-smoke-configuration.ts',
  ],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
});
