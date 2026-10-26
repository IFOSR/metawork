import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * DeepSeek-Harness-style Git snapshot channel.
 *
 * The user's index, refs and objects are never written: every command runs with
 * a private `GIT_INDEX_FILE` and a private `GIT_OBJECT_DIRECTORY` that only
 * *reads* the repository's objects through `GIT_ALTERNATE_OBJECT_DIRECTORIES`.
 * That makes "what changed this round" a tree diff instead of a status listing,
 * so renames, deletions and line counts come from Git itself.
 *
 * Every command is bounded (timeout, output bytes, file count) because the
 * channel must never turn one huge Workspace into an unbounded observation.
 */

export type GitSnapshotFailure =
  | 'not_repository'
  | 'command_failed'
  | 'timeout'
  | 'output_limited';

export interface GitSnapshotFile {
  path: string;
  added: number;
  deleted: number;
  binary?: true;
}

export interface GitSnapshot {
  /** Tree id of the captured worktree state. */
  tree: string;
  /** Tree the diff was taken against (null for the first observation). */
  baselineTree: string | null;
  files: GitSnapshotFile[];
  /** Paths Git ignores, so they are invisible to this channel. */
  ignoredPaths: string[];
  truncated: boolean;
}

export type GitSnapshotResult =
  | { status: 'ok'; snapshot: GitSnapshot }
  | { status: GitSnapshotFailure; detail: string };

export interface GitSnapshotLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxFiles: number;
}

export const DEFAULT_GIT_SNAPSHOT_LIMITS: GitSnapshotLimits = {
  timeoutMs: 10_000,
  maxOutputBytes: 4 * 1024 * 1024,
  maxFiles: 2_000,
};

type GitRun =
  | { ok: true; stdout: string; detail: '' }
  | { ok: false; stdout: string; status: GitSnapshotFailure; detail: string };

/**
 * Captures one tree id, optionally diffed against `baselineTree`. The baseline
 * must come from a previous call in the same Workspace; nothing is persisted in
 * the repository itself.
 */
export function captureGitSnapshot(input: {
  workspaceRoot: string;
  baselineTree?: string | null;
  /** Reuse one private object directory for a before/after pair. The caller owns its cleanup. */
  scratchDirectory?: string;
  limits?: Partial<GitSnapshotLimits>;
}): GitSnapshotResult {
  const limits = { ...DEFAULT_GIT_SNAPSHOT_LIMITS, ...input.limits };
  const workspaceRoot = resolve(input.workspaceRoot);
  const ownsScratch = !input.scratchDirectory;
  const scratch = input.scratchDirectory ?? mkdtempSync(join(tmpdir(), 'metawork-git-snapshot-'));
  // `GIT_OBJECT_DIRECTORY` must exist, otherwise Git reports the Workspace as
  // "not a git repository" and the channel would be silently misclassified.
  mkdirSync(join(scratch, 'objects'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(scratch, `index-${randomUUID()}`),
    GIT_OBJECT_DIRECTORY: join(scratch, 'objects'),
    GIT_OPTIONAL_LOCKS: '0',
    // Read-only view of the repository's existing objects.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(workspaceRoot, '.git', 'objects'),
  };
  const git = (args: readonly string[], stdin?: string): GitRun => {
    const result = spawnSync('git', [
      '-c', `safe.directory=${workspaceRoot}`,
      ...args,
    ], {
      cwd: workspaceRoot,
      env,
      encoding: 'utf8',
      input: stdin,
      timeout: limits.timeoutMs,
      windowsHide: true,
      maxBuffer: limits.maxOutputBytes,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        stdout: '',
        status: code === 'ETIMEDOUT'
          ? 'timeout'
          : code === 'ENOBUFS' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'output_limited'
            : 'command_failed',
        detail: result.error.message,
      };
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim();
      return {
        ok: false,
        stdout: String(result.stdout ?? ''),
        status: /not a git repository/iu.test(stderr) ? 'not_repository' : 'command_failed',
        detail: stderr || `git exited with ${String(result.status)}`,
      };
    }
    return { ok: true, stdout: String(result.stdout ?? ''), detail: '' };
  };

  try {
    // `add --all --ignore-errors` stages tracked, untracked and renamed paths
    // into the private index. Ignored paths stay invisible, which the caller
    // reports as a coverage gap rather than as "no change".
    const added = git(['add', '--all', '--ignore-errors', '--', '.']);
    if (!added.ok) return { status: added.status, detail: added.detail };

    const tree = git(['write-tree']);
    if (!tree.ok) return { status: tree.status, detail: tree.detail };
    const capturedTree = tree.stdout.trim();
    if (!capturedTree) return { status: 'command_failed', detail: 'git write-tree produced no tree id' };

    const empty = git(['hash-object', '-t', 'tree', '--stdin'], '');
    if (!empty.ok) return { status: empty.status, detail: empty.detail };
    const baselineTree = input.baselineTree ?? empty.stdout.trim();

    const diff = git([
      'diff-tree', '-r', '-M', '--numstat', '--no-commit-id',
      baselineTree, capturedTree,
    ]);
    if (!diff.ok) return { status: diff.status, detail: diff.detail };

    const files: GitSnapshotFile[] = [];
    let truncated = false;
    for (const line of diff.stdout.split('\n')) {
      if (!line.trim()) continue;
      if (files.length >= limits.maxFiles) {
        truncated = true;
        break;
      }
      const parsed = parseNumstatLine(line);
      if (parsed) files.push(parsed);
    }

    // Ignored paths are the channel's blind spot: report them so coverage is
    // never claimed as complete while undeclared build output may have changed.
    // `ls-files` names the ignored *files* (a directory entry would hide them).
    const ignored = git(['ls-files', '-o', '-i', '--exclude-standard', '-z']);
    if (!ignored.ok) return { status: ignored.status, detail: ignored.detail };
    const ignoredPaths = parseIgnoredPaths(ignored.stdout, limits.maxFiles);

    return {
      status: 'ok',
      snapshot: {
        tree: capturedTree,
        baselineTree: input.baselineTree ?? null,
        files,
        ignoredPaths,
        truncated,
      },
    };
  } finally {
    if (ownsScratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function parseNumstatLine(line: string): GitSnapshotFile | null {
  // `<added>\t<deleted>\t<path>`, with `-` for binary content. Renames are
  // reported as `old => new` (or `dir/{old => new}/file`), so the destination is
  // what the record lists.
  const match = /^(\d+|-)\t(\d+|-)\t(.+)$/u.exec(line.trim());
  if (!match) return null;
  const [, addedRaw, deletedRaw, rawPath] = match;
  const path = normalizeRenamePath(rawPath!.replace(/\\/gu, '/'));
  if (!path) return null;
  if (addedRaw === '-' || deletedRaw === '-') {
    return { path, added: 0, deleted: 0, binary: true };
  }
  return { path, added: Number(addedRaw), deleted: Number(deletedRaw) };
}

/** Collapses Git's rename notation to the destination path. */
function normalizeRenamePath(path: string): string {
  const braced = /^(.*)\{([^{}]*) => ([^{}]*)\}(.*)$/u.exec(path);
  if (braced) {
    const [, prefix, , to, suffix] = braced;
    return `${prefix}${to}${suffix}`.replace(/\/{2,}/gu, '/').trim();
  }
  const arrow = path.lastIndexOf(' => ');
  return (arrow === -1 ? path : path.slice(arrow + 4)).trim();
}

function parseIgnoredPaths(stdout: string, limit: number): string[] {
  const paths = stdout
    .split('\0')
    .map(entry => entry.trim())
    .map(entry => entry.startsWith('!! ') ? entry.slice(3) : entry)
    .map(entry => entry.replace(/\\/gu, '/'))
    .filter(Boolean);
  return [...new Set(paths)].slice(0, limit);
}
