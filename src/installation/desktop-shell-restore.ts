import { access, rename, rm } from 'node:fs/promises';
import type { DesktopActivationRecord } from './desktop-activation.js';

/** Restore the retained original bundle without exposing a second failed app. */
export async function restoreDesktopApplication(record: Pick<DesktopActivationRecord,
  'applicationPath' | 'backupApplicationPath'>): Promise<void> {
  const hasBackup = await access(record.backupApplicationPath).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (hasBackup) {
    // Only the replaceable application bundle is discarded; account data lives
    // outside it. Keep the original backup until its rename succeeds, so an
    // interruption between removal and rename remains recoverable on retry.
    await rm(record.applicationPath, { recursive: true, force: true });
    await rename(record.backupApplicationPath, record.applicationPath);
  }
  await rm(`${record.applicationPath}.metawork-staged`, { recursive: true, force: true });
}
