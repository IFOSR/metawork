/**
 * Resolution of the memory engine sidecar command.
 *
 * The engine is shipped inside every release as its own tree, so the launcher
 * only has to find it:
 *
 *   1. `METAWORK_MEMORY_SIDECAR_DIR` — explicit installation directory;
 *   2. `<install root>/memory/tdai` — the managed installation every installer
 *      and updater writes (see `stageSourceRelease`).
 *
 * Two entry points are supported because the release ships a compiled gateway
 * while a development checkout only has TypeScript sources:
 *
 *   - `dist/gateway/server.js` — preferred, plain Node, no build tooling;
 *   - `src/gateway/server.ts`  — development, run through `tsx`.
 *
 * Pure module: no process spawning.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySidecarCommand } from './memory-runtime.js';

export interface MemorySidecarResolution {
  command: MemorySidecarCommand | null;
  /** Why no command was resolved, for the runtime log. */
  reason?: string;
  /** Root the engine was found under, for diagnostics. */
  root?: string;
}

export function resolveMemorySidecarCommand(input: {
  installRoot?: string;
  env?: NodeJS.ProcessEnv;
}): MemorySidecarResolution {
  const env = input.env ?? process.env;
  const candidates: string[] = [];
  const explicit = env.METAWORK_MEMORY_SIDECAR_DIR?.trim();
  if (explicit) candidates.push(explicit);
  if (input.installRoot) candidates.push(join(input.installRoot, 'memory', 'tdai'));

  for (const candidate of candidates) {
    const command = resolveMemorySidecarEntry(candidate);
    if (command) return { command, root: candidate };
  }
  return {
    command: null,
    reason: candidates.length
      ? `memory sidecar installation not found (${candidates.join(', ')})`
      : 'memory sidecar installation not configured',
  };
}

/** Resolve the engine entry point of one installation root. */
export function resolveMemorySidecarEntry(root: string): MemorySidecarCommand | null {
  const compiled = join(root, 'dist', 'gateway', 'server.js');
  if (existsSync(compiled)) {
    return { command: process.execPath, args: [compiled], cwd: root };
  }
  const source = join(root, 'src', 'gateway', 'server.ts');
  if (existsSync(source)) {
    return { command: process.execPath, args: ['--import', 'tsx', source], cwd: root };
  }
  return null;
}
