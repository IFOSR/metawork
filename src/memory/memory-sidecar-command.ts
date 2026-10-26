/**
 * Resolution of the memory engine sidecar command.
 *
 * The engine version is pinned independently of MetaWork (design §12 / R7), so
 * the launcher is discovered at runtime instead of being a hard dependency:
 *
 *   1. `METAWORK_MEMORY_SIDECAR_DIR` — explicit installation directory;
 *   2. `<install root>/memory/tdai` — the default managed installation;
 *   3. nothing — the engine is expected to be running already.
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
    const entry = join(candidate, 'src', 'gateway', 'server.ts');
    if (!existsSync(entry)) continue;
    return {
      command: {
        command: process.execPath,
        args: ['--import', 'tsx', entry],
        cwd: candidate,
      },
    };
  }
  return {
    command: null,
    reason: candidates.length
      ? `memory sidecar installation not found (${candidates.join(', ')})`
      : 'memory sidecar installation not configured',
  };
}
