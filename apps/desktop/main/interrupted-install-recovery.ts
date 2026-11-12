import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const BACKUP_MARKER = '.interrupted-update-';

/** Move an interrupted installation aside so the signed Desktop payload can install cleanly. */
export async function isolateInterruptedInstallation(root: string): Promise<string | null> {
  const info = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Previous installation root is not a real directory');

  await assertNoLiveUpdateHelper(root);
  await assertNoLiveServers(root);

  const backup = `${root}${BACKUP_MARKER}${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`;
  await rename(root, backup);
  return backup;
}

/** Restore the old root if the clean install itself failed before it became usable. */
export async function restoreInterruptedInstallation(root: string, backup: string): Promise<void> {
  if (dirname(root) !== dirname(backup) || !basename(backup).startsWith(`${basename(root)}${BACKUP_MARKER}`)) {
    throw new Error('Interrupted installation backup identity mismatch');
  }
  const preserved = await lstat(backup);
  if (!preserved.isDirectory() || preserved.isSymbolicLink()) throw new Error('Previous installation backup is unavailable');
  await assertNoLiveUpdateHelper(root);
  await assertNoLiveServers(root);
  const current = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (current) {
    if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Partial installation root is not a real directory');
    await rename(root, `${root}.failed-install-${randomUUID()}`);
  }
  await rename(backup, root);
}

async function assertNoLiveUpdateHelper(root: string): Promise<void> {
  const lockPath = join(root, 'upgrades/desktop-helper.lock');
  const raw = await readFile(lockPath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return;
  const pid = Number(raw.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Previous Desktop update helper lock is invalid');
  if (isProcessAlive(pid)) throw new Error('Previous Desktop update helper is still running');
}

async function assertNoLiveServers(root: string): Promise<void> {
  const lockPaths = [join(root, 'data/runtime.lock')];
  const accounts = await readdir(join(root, 'accounts'), { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const account of accounts) {
    if (account.isDirectory()) lockPaths.push(join(root, 'accounts', account.name, 'data/runtime.lock'));
  }
  for (const lockPath of lockPaths) {
    const raw = await readFile(lockPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (raw === null) continue;
    let pid: number;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      pid = Number(parsed.pid);
    } catch {
      pid = Number(raw.trim());
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Previous Server lock is invalid');
    if (isProcessAlive(pid)) throw new Error('Previous MetaWork Server is still running');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

