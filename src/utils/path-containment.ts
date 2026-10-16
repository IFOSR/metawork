import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Containment tests for managed paths.
 *
 * String prefixes (`target.startsWith(root + '/')`) are wrong twice over: on
 * Windows `resolve` returns backslashes, so the check rejects every legitimate
 * child path, and even on POSIX it accepts a sibling directory that merely
 * shares the prefix. `path.relative` is separator-aware and case-aware per
 * platform, so it answers the real question on every platform.
 */
export function isPathInside(parent: string, candidate: string): boolean {
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  if (parentPath === candidatePath) return true;
  const relativePath = relative(parentPath, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

/** Containment that must be strictly below `parent`. */
export function isPathStrictlyInside(parent: string, candidate: string): boolean {
  return resolve(parent) !== resolve(candidate) && isPathInside(parent, candidate);
}
