import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { WorkspaceRetentionService } from '../../src/execution/workspace-retention-service.js';
import { WorkspaceStore, type StoredWorkspaceCheckpoint } from '../../src/execution/workspace-store.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteWorkspaceRepository } from '../../src/storage/workspace-repo.js';

function checkpointObjects(checkpoint: StoredWorkspaceCheckpoint) {
  return checkpoint.manifest.entries
    .filter(entry => entry.type === 'file' && entry.hash && entry.objectUri)
    .map(entry => ({ hash: entry.hash!, uri: entry.objectUri!, size: entry.size }));
}

describe('WorkspaceRetentionService', () => {
  it('waits for terminal retention and deletes CAS content only after the last checkpoint reference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metaclaw-retention-'));
    const exportedArtifact = join(root, 'exported-artifact.txt');
    writeFileSync(exportedArtifact, 'keep me');
    try {
      const db = new Database(':memory:');
      runMigrations(db);
      const repository = new SqliteWorkspaceRepository(db);
      const store = new WorkspaceStore(join(root, 'store'));
      const now = new Date('2026-07-22T00:00:00.000Z');
      const create = async (taskId: string) => {
        const workspace = await store.ensureWorkspace({ taskId, generationId: 'generation', subtaskId: 'subtask' }, 'git');
        writeFileSync(join(workspace.filesPath, 'shared.txt'), 'same content');
        const checkpoint = await store.createCheckpoint(workspace, { reason: 'success', now: now.toISOString() });
        repository.upsert({
          id: workspace.id,
          taskId,
          generationId: 'generation',
          subtaskId: 'subtask',
          kind: 'git',
          rootUri: pathToFileURL(workspace.rootPath).href,
          baseline: {},
          managedRepositoryUri: null,
          managedBranch: null,
          headCommit: null,
          currentCheckpointId: null,
          status: 'done',
          cleanupAfter: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        repository.recordCheckpoint({
          id: checkpoint.id,
          workspaceId: workspace.id,
          attemptId: null,
          reason: 'success',
          manifestUri: checkpoint.manifestUri,
          manifestHash: checkpoint.manifestHash,
          manifestSize: checkpoint.manifestSize,
          createdAt: checkpoint.manifest.createdAt,
          objects: checkpointObjects(checkpoint),
        });
        return { workspace, checkpoint };
      };
      const first = await create('task-a');
      const second = await create('task-b');
      const objectPath = new URL(first.checkpoint.manifest.entries.find(entry => entry.hash)!.objectUri!);
      const retention = new WorkspaceRetentionService(repository, store, 0);

      retention.reconcileTaskStatuses([{ id: 'task-a', status: 'cancelled' }], now);
      expect(await retention.sweepDue(now)).toEqual({ workspaces: 1, objects: 0, repositories: 0 });
      expect(existsSync(first.workspace.rootPath)).toBe(false);
      expect(existsSync(objectPath)).toBe(true);

      retention.reconcileTaskStatuses([{ id: 'task-b', status: 'archived' }], now);
      expect(await retention.sweepDue(now)).toEqual({ workspaces: 1, objects: 1, repositories: 0 });
      expect(existsSync(second.workspace.rootPath)).toBe(false);
      expect(existsSync(objectPath)).toBe(false);
      expect(existsSync(exportedArtifact)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
