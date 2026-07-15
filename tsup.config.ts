import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/planner-mcp.ts', 'src/generate-planner-schema.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
});
