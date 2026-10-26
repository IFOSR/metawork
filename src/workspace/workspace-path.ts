import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import { defaultMountCaseSensitivity } from '../resource/workspace-claim.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/u;

export type WorkspacePathErrorCode =
  | 'not_absolute'
  | 'not_found'
  | 'not_directory'
  | 'unsupported_root'
  | 'escape'
  | 'symlink'
  | 'not_regular_file';

export class WorkspacePathError extends Error {
  constructor(readonly code: WorkspacePathErrorCode, message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

export interface CanonicalWorkspacePath {
  /** `realpath` of an existing directory; stable across symlink aliases and `..` spellings. */
  canonicalPath: string;
  device?: string;
}

export interface ResolvedWorkspaceFile {
  /** Canonical absolute path of the regular file. */
  absolutePath: string;
  /** Normalized Workspace-relative path used to address the file. */
  relativePath: string;
  size: number;
}

/**
 * Canonical identity of a Workspace directory. Trailing slashes, `..` and
 * symlink aliases all collapse to one spelling, so two claims over the same
 * physical directory can never disagree. A missing path, a non-directory and
 * the filesystem root are rejected instead of being normalized into something
 * surprising.
 */
export async function canonicalizeWorkspacePath(path: string): Promise<CanonicalWorkspacePath> {
  if (!isAbsolute(path) || path.startsWith('\\\\') || WINDOWS_ABSOLUTE_PATH.test(path)) {
    throw new WorkspacePathError('not_absolute', `workspace path must be absolute: ${path}`);
  }
  const canonicalPath = await realpath(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspacePathError('not_found', `workspace path does not exist: ${path}`);
    }
    throw error;
  });
  if (canonicalPath === parse(canonicalPath).root) {
    throw new WorkspacePathError('unsupported_root', 'the filesystem root cannot be a workspace');
  }
  const info = await stat(canonicalPath);
  if (!info.isDirectory()) {
    throw new WorkspacePathError('not_directory', `workspace path is not a directory: ${path}`);
  }
  return { canonicalPath, device: String(info.dev) };
}

/**
 * Ancestor/descendant overlap of two canonical absolute paths. Both inputs must
 * already be absolute; case folding follows the mount default unless the caller
 * knows the target filesystem is case sensitive.
 */
export function isPathOverlap(
  left: string,
  right: string,
  options: { caseSensitive?: boolean } = {},
): boolean {
  const caseSensitive = options.caseSensitive ?? defaultMountCaseSensitivity();
  const leftSegments = absoluteSegments(left, caseSensitive);
  const rightSegments = absoluteSegments(right, caseSensitive);
  const [shorter, longer] = leftSegments.length <= rightSegments.length
    ? [leftSegments, rightSegments]
    : [rightSegments, leftSegments];
  return shorter.every((segment, index) => segment === longer[index]);
}

/**
 * Resolves one Workspace-relative file reference: no absolute input, no `..`
 * escape, no symlinked final component, and the resolved file must still sit
 * inside the Workspace after `realpath` (so a symlinked parent cannot smuggle it
 * out). Callers use the returned canonical path for reading, never the raw
 * input.
 */
export async function assertWorkspaceRelativePath(
  root: string,
  relativePath: string,
): Promise<ResolvedWorkspaceFile> {
  const segments = relativeSegments(relativePath);
  const canonicalRoot = await realpath(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspacePathError('not_found', `workspace root does not exist: ${root}`);
    }
    throw error;
  });
  const requested = resolve(canonicalRoot, segments.join('/'));
  if (!isWithin(canonicalRoot, requested)) {
    throw new WorkspacePathError('escape', `path escapes the workspace: ${relativePath}`);
  }
  const entry = await lstat(requested).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkspacePathError('not_found', `workspace file does not exist: ${relativePath}`);
    }
    throw error;
  });
  if (entry.isSymbolicLink()) {
    throw new WorkspacePathError('symlink', `workspace file must not be a symbolic link: ${relativePath}`);
  }
  if (!entry.isFile()) {
    throw new WorkspacePathError('not_regular_file', `workspace file is not a regular file: ${relativePath}`);
  }
  const absolutePath = await realpath(requested);
  if (!isWithin(canonicalRoot, absolutePath)) {
    throw new WorkspacePathError('escape', `resolved file escapes the workspace: ${relativePath}`);
  }
  return { absolutePath, relativePath: segments.join('/'), size: entry.size };
}

/** True when `candidate` is `root` itself or a descendant of it. */
export function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Lexical Workspace-relative path check used before any filesystem access.
 *
 * Planner output and persisted intents are untrusted: absolute paths, Windows
 * paths, `.`/`..` segments, control characters and empty segments are rejected
 * instead of being normalized into something surprising. The canonical
 * `realpath`, symlink and regular-file rules stay in
 * `assertWorkspaceRelativePath`, which can only run once a file exists.
 */
export function isWorkspaceRelativePath(value: string): boolean {
  try {
    relativeSegments(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes declared Workspace-relative target paths (NFC, `/` separators) and
 * rejects anything that is not strictly inside the Workspace.
 */
export function normalizeWorkspaceTargetPaths(paths: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== 'string') {
      throw new WorkspacePathError('escape', 'workspace target path must be a string');
    }
    const value = relativeSegments(path).join('/');
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function relativeSegments(relativePath: string): string[] {
  if (isAbsolute(relativePath) || WINDOWS_ABSOLUTE_PATH.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw new WorkspacePathError('not_absolute', `workspace path must be relative: ${relativePath}`);
  }
  const segments = relativePath.normalize('NFC').replace(/\\/gu, '/').split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || CONTROL_CHARACTERS.test(segment)) {
      throw new WorkspacePathError('escape', `unsafe workspace-relative path: ${relativePath}`);
    }
  }
  return segments;
}

function absoluteSegments(path: string, caseSensitive: boolean): string[] {
  if (!isAbsolute(path)) {
    throw new WorkspacePathError('not_absolute', `path must be absolute: ${path}`);
  }
  const normalized = path.normalize('NFC').replace(/\\/gu, '/');
  const root = parse(normalized).root.replace(/\\/gu, '/');
  const remainder = normalized.slice(root.length).replace(/\/+$/u, '');
  const segments = remainder ? remainder.split('/') : [];
  return caseSensitive ? segments : segments.map(segment => segment.toLocaleLowerCase('en-US'));
}
