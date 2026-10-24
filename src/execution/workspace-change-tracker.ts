import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface WorkspaceState {
  kind: 'git_status_v1';
  paths: Record<string, string | null>;
  truncated: boolean;
  /**
   * Line counts for the same dirty paths, used to report added/deleted lines
   * without storing file contents. Absent in states captured before this field
   * existed, in which case the change record reports zero line deltas.
   */
  lineCounts?: Record<string, number | null>;
}

export interface WorkspaceDeltaEntry {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface WorkspaceDelta {
  kind: 'git_status_delta_v1';
  changed: WorkspaceDeltaEntry[];
  baselineTruncated: boolean;
  finalTruncated: boolean;
}

const MAX_TRACKED_PATHS = 2_000;
const MAX_HASH_BYTES = 8 * 1024 * 1024;

/** Captures dirty-path hashes without storing file contents or modifying the worktree. */
export function captureWorkspaceState(workspaceRoot: string): WorkspaceState {
  const resolvedRoot = resolve(workspaceRoot);
  const result = spawnSync('git', [
    '-c', `safe.directory=${resolvedRoot}`,
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`workspace state capture failed: ${String(result.stderr || result.error?.message || 'git status failed').trim()}`);
  }
  const paths: Record<string, string | null> = {};
  const lineCounts: Record<string, number | null> = {};
  const entries = result.stdout.split('\0').filter(Boolean);
  for (const entry of entries.slice(0, MAX_TRACKED_PATHS)) {
    const relativePath = statusPath(entry);
    if (!relativePath) continue;
    const absolutePath = resolve(workspaceRoot, relativePath);
    const sample = inspectPath(absolutePath);
    paths[relativePath] = sample.hash;
    lineCounts[relativePath] = sample.lines;
  }
  return {
    kind: 'git_status_v1',
    paths,
    truncated: entries.length > MAX_TRACKED_PATHS,
    lineCounts,
  };
}

export function deriveWorkspaceDelta(before: WorkspaceState, after: WorkspaceState): WorkspaceDelta {
  const changed: WorkspaceDeltaEntry[] = [];
  const paths = new Set([...Object.keys(before.paths), ...Object.keys(after.paths)]);
  for (const path of [...paths].sort()) {
    const beforeHash = before.paths[path] ?? null;
    const afterHash = after.paths[path] ?? null;
    if (beforeHash !== afterHash) changed.push({ path, beforeHash, afterHash });
  }
  return {
    kind: 'git_status_delta_v1',
    changed,
    baselineTruncated: before.truncated,
    finalTruncated: after.truncated,
  };
}

export function parseWorkspaceState(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'git_status_v1'
    || typeof record.truncated !== 'boolean'
    || !record.paths
    || typeof record.paths !== 'object'
    || Array.isArray(record.paths)
  ) return null;
  const paths: Record<string, string | null> = {};
  for (const [path, hash] of Object.entries(record.paths as Record<string, unknown>)) {
    if (typeof hash !== 'string' && hash !== null) return null;
    paths[path] = hash;
  }
  const lineCounts: Record<string, number | null> = {};
  if (record.lineCounts && typeof record.lineCounts === 'object' && !Array.isArray(record.lineCounts)) {
    for (const [path, lines] of Object.entries(record.lineCounts as Record<string, unknown>)) {
      if (typeof lines === 'number' && Number.isFinite(lines) && lines >= 0) lineCounts[path] = lines;
      else lineCounts[path] = null;
    }
  }
  return {
    kind: 'git_status_v1',
    paths,
    truncated: record.truncated,
    lineCounts,
  };
}

export function parseWorkspaceDelta(value: unknown): WorkspaceDelta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'git_status_delta_v1'
    || typeof record.baselineTruncated !== 'boolean'
    || typeof record.finalTruncated !== 'boolean'
    || !Array.isArray(record.changed)) return null;
  const changed: WorkspaceDeltaEntry[] = [];
  for (const entry of record.changed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== 'string'
      || (typeof item.beforeHash !== 'string' && item.beforeHash !== null)
      || (typeof item.afterHash !== 'string' && item.afterHash !== null)) return null;
    changed.push({
      path: item.path,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
    });
  }
  return {
    kind: 'git_status_delta_v1',
    changed,
    baselineTruncated: record.baselineTruncated,
    finalTruncated: record.finalTruncated,
  };
}

function statusPath(entry: string): string | null {
  const raw = entry.slice(3);
  const renamed = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  return renamed.trim() || null;
}

interface PathSample {
  hash: string | null;
  lines: number | null;
}

/** One read per path: the content hash and, for text files, the line count. */
function inspectPath(path: string): PathSample {
  if (!existsSync(path)) return { hash: null, lines: null };
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { hash: `non_file:${stat.mode}:${stat.size}`, lines: null };
    if (stat.size > MAX_HASH_BYTES) return { hash: `large_file:${stat.size}:${stat.mtimeMs}`, lines: null };
    const bytes = readFileSync(path);
    return {
      hash: createHash('sha256').update(bytes).digest('hex'),
      lines: countLines(bytes),
    };
  } catch {
    return { hash: null, lines: null };
  }
}

/** Binary-looking content has no meaningful line delta. */
function countLines(bytes: Buffer): number | null {
  if (bytes.includes(0)) return null;
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

export type WorkspaceCaptureFailure = 'not_repository' | 'command_failed';

/** Why a Git observation channel is missing, for coverage/failure reasons. */
export function classifyWorkspaceCaptureFailure(error: unknown): WorkspaceCaptureFailure {
  const text = error instanceof Error ? error.message : String(error);
  return /not a git repository/iu.test(text) ? 'not_repository' : 'command_failed';
}
