import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceGitService } from '../../src/execution/workspace-git-service.js';
import { ServiceWorktreeService } from '../../src/execution/service-worktree-service.js';
import type { ServiceGitWorktree } from '../../src/workspace/workspace-git-contracts.js';

describe('fixed service manifest provenance', () => {
  it('accepts canonical aliases of the pinned checkout and rejects foreign or untracked files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mw-service-provenance-'));
    try {
      const userRoot = join(directory, 'user');
      await mkdir(userRoot);
      await writeFile(join(userRoot, '.metawork-service.json'), '{}');
      const git = new WorkspaceGitService({ internalRoot: join(directory, 'runtime') });
      const root = await git.initialize({ accountId: 'a', workspaceId: 'w', userRoot });
      let record: ServiceGitWorktree | null = null;
      const services = new ServiceWorktreeService(git, {
        sourceForTask: () => ({ workspaceId: 'w', commit: root.mainCommit }),
        root: () => root,
        serviceWorktree: () => record,
        saveServiceWorktree: (next: ServiceGitWorktree) => { record = next; },
      } as never);
      const checkout = await services.prepare('task', 'discovery_task');
      const alias = join(directory, 'checkout-alias');
      await symlink(checkout.rootPath, alias);
      expect(await services.containsPublishedFile('task', alias, '.metawork-service.json')).toBe(true);
      expect(await services.containsPublishedFile('task', await realpath(checkout.rootPath), '.metawork-service.json')).toBe(true);
      expect(await services.containsPublishedFile('task', userRoot, '.metawork-service.json')).toBe(false);
      await writeFile(join(checkout.rootPath, 'untracked.json'), '{}');
      expect(await services.containsPublishedFile('task', alias, 'untracked.json')).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
