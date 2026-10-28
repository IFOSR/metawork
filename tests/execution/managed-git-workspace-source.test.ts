import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedGitWorkspaceService } from '../../src/execution/managed-git-workspace.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-git-source-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(join(root, 'store'));
  await store.initialize();
  const service = new ManagedGitWorkspaceService(store);
  const workspace = join(root, 'user-workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), 'user project\n');
  const identity = { taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1' };
  return { root, store, service, workspace, identity };
}

describe('managed Git source safety', () => {
  it('refuses the internal workspace store as a Task source', async () => {
    const { service, store, identity } = await fixture();
    // This is what the account-wide default pointed at: importing it would copy
    // the store into one of its own repositories.
    await expect(service.ensure(identity, store.rootPath))
      .rejects.toThrow('managed Git source must be the authorized Workspace, not the internal workspace store');
    await expect(service.ensure(identity, store.repositoriesPath))
      .rejects.toThrow('managed Git source must be the authorized Workspace, not the internal workspace store');
  });

  it('accepts the authorized Workspace and imports a plain (non-Git) project once', async () => {
    const { service, workspace, identity } = await fixture();
    const created = await service.ensure(identity, workspace);
    expect(created.filesPath.startsWith(service.repositoriesPath.replace(/repositories$/u, ''))).toBe(true);
    await expect(service.ensure(identity, workspace)).resolves.toMatchObject({
      filesPath: created.filesPath,
    });
  }, 30_000);
});
