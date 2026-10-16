import { closeSync, fsyncSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Durable write primitives for atomic-replace files.
 *
 * Two POSIX assumptions do not hold on Windows, and neither of them may be
 * papered over per call site:
 *
 * - `fsync` on a read-only descriptor fails with `EPERM`. Windows
 *   `FlushFileBuffers` requires a handle opened with write access, so the
 *   read-only reopen used on POSIX must reopen for reading and writing instead.
 * - A directory handle cannot be flushed at all. Windows has no directory
 *   `fsync` equivalent that Node can reach, so directory durability degrades to
 *   "the rename was ordered before the next read", which is the strongest
 *   guarantee the platform offers here.
 *
 * File content durability is preserved on every platform; only the
 * directory-entry flush is POSIX-only. Callers keep their own recovery and
 * fail-closed rules - this module never swallows a file-level flush failure.
 *
 * See docs/adr/0030-native-release-trust-and-upgrade-transaction.md and the
 * Windows native Web plan docs/plans/2026-10-16-windows-native-web-isolated-fix.md.
 */

const canFlushReadOnlyFile = process.platform !== 'win32';
const canFlushDirectory = process.platform !== 'win32';

function fileSyncMode(): 'r' | 'r+' {
  return canFlushReadOnlyFile ? 'r' : 'r+';
}

/** Flush one file's contents to stable storage. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, fileSyncMode());
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Synchronous variant of {@link syncFile} for journal writers. */
export function syncFileSync(path: string): void {
  const descriptor = openSync(path, fileSyncMode());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Flush a directory entry after a rename or unlink. No-op where the platform
 * cannot flush directories; callers must not treat that as a content-durability
 * guarantee for the file itself.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (!canFlushDirectory) return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Synchronous variant of {@link syncDirectory}. */
export function syncDirectorySync(path: string): void {
  if (!canFlushDirectory) return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
