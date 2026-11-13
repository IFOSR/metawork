import { defineConfig } from 'tsup';
import { cp } from 'node:fs/promises';

export default defineConfig({
  // Object form so one entry can pin an explicit output name: the Pi
  // stall-guard extension resolves the stall core as its sibling in `dist`.
  entry: {
    index: 'src/index.ts',
    'install-cli': 'src/install-cli.ts',
    'desktop-install-cli': 'src/desktop-install-cli.ts',
    'desktop-update-cli': 'src/desktop-update-cli.ts',
    'planner-mcp': 'src/planner-mcp.ts',
    'generate-planner-schema': 'src/generate-planner-schema.ts',
    'capability-request-cli': 'src/capability-request-cli.ts',
    'capability-use-cli': 'src/capability-use-cli.ts',
    'image-api-cli': 'src/image-api-cli.ts',
    'emit-pi-attempt-extension': 'src/emit-pi-attempt-extension.ts',
    'tool-stall-core': 'src/executor/tool-stall-core.ts',
    'prepare-smoke-configuration': 'src/prepare-smoke-configuration.ts',
    'conversation-history-worker': 'src/conversation-history-worker.ts',
  },
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
    // The Pi tool-call stall guard ships as extension source, resolved by the
    // attempt home shim written in pi-cli-driver.ts.
    await cp('src/executor/pi-tool-stall', 'dist/pi-tool-stall', { recursive: true });
    // The Manager extension ships as extension source loaded by the packaged
    // upstream Pi (ADR-0055 D6).
    await cp('src/planning/manager-host/extension', 'dist/pi-manager', { recursive: true });
  },
});
