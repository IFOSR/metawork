import { rename } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

/** Preserve atomic replacement; never unlink the destination to evade a lock. */
export async function replaceFile(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    try { await rename(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')
        || Date.now() >= deadline) throw error;
      // A Windows reader or scanner can briefly hold a non-delete-sharing
      // handle. Persistent permissions/locks still fail within the fixed bound.
      await setTimeout(20);
    }
  }
}
