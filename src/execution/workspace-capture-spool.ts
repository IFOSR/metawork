import { readFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

interface CaptureLine {
  phase?: 'before' | 'after';
  tool?: string;
  path?: string;
  hash?: string | null;
  size?: number | null;
}

/**
 * Reads the file-tool capture spool the Pi extension writes beside the attempt
 * home, then reports the Workspace-relative paths whose bytes actually changed.
 * Paths outside the Workspace are ignored: the delivery contract is
 * Workspace-relative.
 */
export async function readCapturedWorkspacePaths(
  spoolPath: string,
  workspaceRoot: string,
): Promise<string[]> {
  const raw = await readFile(spoolPath, 'utf8').catch(() => null);
  if (!raw) return [];
  const before = new Map<string, string | null>();
  const after = new Map<string, string | null>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: CaptureLine;
    try { entry = JSON.parse(line) as CaptureLine; } catch { continue; }
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path)) continue;
    const relativePath = relative(workspaceRoot, entry.path).split('\\').join('/');
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) continue;
    const hash = typeof entry.hash === 'string' ? entry.hash : currentHash(entry.path);
    if (entry.phase === 'before') before.set(relativePath, hash);
    else if (entry.phase === 'after') after.set(relativePath, hash);
  }
  const changed: string[] = [];
  for (const [path, afterHash] of after) {
    if (before.get(path) !== afterHash) changed.push(path);
  }
  for (const [path, beforeHash] of before) {
    if (!after.has(path) && beforeHash !== null && !after.has(path)) changed.push(path);
  }
  return [...new Set(changed)].sort();
}

function currentHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}
