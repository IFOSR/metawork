import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWorkspaceGitLock } from '../../src/execution/workspace-git-lock.js';

async function repositoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-git-lock-'));
  await mkdir(join(root, 'repository.git'), { recursive: true });
  return root;
}
describe('withWorkspaceGitLock', () => {
  it('waits for a held lock instead of failing the attempt', async () => {
    const root = await repositoryRoot();
    try {
      const lockPath = join(root, 'metawork-integration.lock');
      // A lock owned by this live process models the parallel contender: the
      // acquisition must wait for it instead of failing with EPERM, which is
      // what Windows reports when a directory rename targets an existing one.
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'held-by-other' }));

      let acquired = false;
      const pending = withWorkspaceGitLock(root, 'integration', async () => {
        acquired = true;
        return 'done';
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      expect(acquired).toBe(false);

      await rm(lockPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await expect(pending).resolves.toBe('done');
      expect(acquired).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes two contenders on the same lock', async () => {
    const root = await repositoryRoot();
    try {
      const order: string[] = [];
      const first = withWorkspaceGitLock(root, 'integration', async () => {
        order.push('first-start');
        await new Promise(resolve => setTimeout(resolve, 150));
        order.push('first-end');
      });
      const second = withWorkspaceGitLock(root, 'integration', async () => {
        order.push('second-start');
        order.push('second-end');
      });

      await Promise.all([first, second]);
      expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
