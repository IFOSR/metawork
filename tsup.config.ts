import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/install-cli.ts',
    'src/desktop-install-cli.ts',
    'src/desktop-update-cli.ts',
    'src/planner-mcp.ts',
    'src/generate-planner-schema.ts',
    'src/capability-request-cli.ts',
    'src/capability-use-cli.ts',
    'src/image-api-cli.ts',
    'src/emit-pi-attempt-extension.ts',
    'src/prepare-smoke-configuration.ts',
    'src/conversation-history-worker.ts',
  ],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['better-sqlite3'],
  onSuccess: async () => {
    // Ship the PDF fonts and their redistribution license with every runtime.
    await cp('src/management/fonts', 'dist/fonts', { recursive: true });
  },
});
