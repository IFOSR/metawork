import { randomUUID } from 'node:crypto';
import { readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * Directory pointers (the active configuration revision, the current release,
 * the compiled agent runtime).
 *
 * POSIX stores these as relative symlinks. Windows reserves symlink creation
 * for callers holding `SeCreateSymbolicLinkPrivilege`, which an ordinary user
 * does not have and must not need, so the same pointer becomes a directory
 * junction there. A junction stores an absolute target, so
 * {@link readDirectoryLinkTarget} converts it back to the relative form every
 * consumer already validates (`revisions/<id>`, `releases/<id>`, ...). The
 * durable pointer contract is therefore identical on both platforms.
 *
 * File pointers are deliberately not covered here: a junction cannot address a
 * file and a hard link is not a general substitute (WAL, backup and rollback
 * open the revision path directly). See
 * docs/plans/2026-10-16-windows-native-web-isolated-fix.md (W3).
 */

const windows = process.platform === 'win32';

/**
 * True when replacing an existing pointer is one atomic rename. Callers that
 * depend on a reader never observing a missing pointer use this to decide
 * whether the journal alone is enough to recover.
 */
export const directoryLinkReplacementIsAtomic = !windows;

/** Create a directory pointer from a target that is relative to the link. */
export async function createDirectoryLink(linkPath: string, target: string): Promise<void> {
  if (!windows) {
    await symlink(target, linkPath, 'dir');
    return;
  }
  // A junction needs an absolute target, and the target must already exist.
  await symlink(resolve(dirname(linkPath), target), linkPath, 'junction');
}

/** Read a directory pointer in the platform-neutral relative form. */
export async function readDirectoryLinkTarget(linkPath: string): Promise<string> {
  const target = await readlink(linkPath);
  if (!windows) return target;
  const cleaned = stripWindowsPrefix(target);
  // Consumers compare and persist pointer targets, so the normalized form uses
  // POSIX separators on every platform.
  return isAbsolute(cleaned) ? relative(dirname(linkPath), cleaned).replaceAll('\\', '/') : target;
}

/**
 * Replace an existing directory pointer.
 *
 * POSIX creates the new link under a temporary name and renames it over the old
 * one, so no reader ever observes a missing pointer. Windows cannot rename over
 * an existing junction, so the old link is removed first and the pointer is
 * missing for the duration of the swap. That intermediate state is safe only
 * because every caller records the intended cutover in a journal before calling
 * this and recovers a missing pointer from that record.
 */
export async function replaceDirectoryLink(linkPath: string, target: string): Promise<void> {
  const temporary = `${linkPath}.next-${randomUUID()}`;
  await createDirectoryLink(temporary, target);
  try {
    if (!windows) {
      await rename(temporary, linkPath);
      return;
    }
    await rm(linkPath, { recursive: false, force: true });
    await rename(temporary, linkPath);
  } catch (error) {
    await rm(temporary, { recursive: false, force: true }).catch(() => undefined);
    throw error;
  }
}

/** A junction target may arrive as `\??\C:\...` or `\\?\C:\...`. */
function stripWindowsPrefix(target: string): string {
  return target.replace(/^\\\\\?\\|^\\\?\?\\/u, '');
}
