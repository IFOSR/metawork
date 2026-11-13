import { chmod, link, lstat, readdir, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function directorySymlinkType(platform: NodeJS.Platform = process.platform): 'dir' | 'junction' {
  return platform === 'win32' ? 'junction' : 'dir';
}

/** Directory pointers (active/current/tools) must be creatable without
 *  privilege on Windows: NTFS directory symlinks require it, junctions do not.
 *  POSIX keeps the caller's target form (relative stays relative); a junction
 *  resolves a relative target against the link's directory, then stores the
 *  absolute path — readlink consumers must accept that form. */
export async function createDirectorySymlink(
  target: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') {
    await symlink(resolve(dirname(linkPath), target), linkPath, 'junction');
    return;
  }
  await symlink(target, linkPath, 'dir');
}

/** File pointers (database revisions) cannot be junctions; NTFS file symlinks
 *  need privilege while a hardlink on the same volume does not. */
export async function createFilePointer(
  target: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') {
    await link(resolve(dirname(linkPath), target), linkPath);
    return;
  }
  await symlink(target, linkPath);
}

/** Windows: NTFS links carry a read-only attribute, so renaming over an
 *  existing pointer always fails with EPERM. Callers have already
 *  journalled/validated the swap; removing the stale pointer and retrying
 *  preserves that semantics. */
export async function renameOverPointer(
  temporaryPath: string,
  pointerPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await rename(temporaryPath, pointerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EPERM' || platform !== 'win32') throw error;
    await rm(pointerPath, { force: true });
    await rename(temporaryPath, pointerPath);
  }
}

/** Undo read-only modes in a tree before rm/copyFile; Windows fails those
 *  operations with EPERM while the read-only attribute is set. */
export async function restoreWriteAccess(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  await chmod(path, info.mode | 0o200).catch(() => undefined);
  if (info.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await restoreWriteAccess(join(path, entry.name));
    }
  }
}

/** Replace an existing file with a prepared temporary file.
 *
 *  Windows refuses `rename` over a target that another handle still holds
 *  (EPERM), while POSIX replaces it atomically. A durable fact that is read
 *  concurrently therefore fails to update on Windows. Retry briefly for the
 *  competing handle to close, then remove the stale target and retry: the
 *  caller has already written and validated the replacement content, so the
 *  only difference is a short window without the target. */
export async function renameReplacingTarget(
  temporaryPath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') {
    await rename(temporaryPath, targetPath);
    return;
  }
  const delays = [0, 10, 25, 50, 100];
  for (const delay of delays) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await rename(temporaryPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
    }
  }
  await rm(targetPath, { force: true });
  await rename(temporaryPath, targetPath);
}
