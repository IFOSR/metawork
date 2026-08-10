import { describe, expect, it, vi } from 'vitest';
import { AttemptExecutionBackendReconciler } from '../../src/execution/attempt-execution-backend-reconciler.js';
import type { AttemptExecutionPersistenceRecord, AttemptExecutionRepositoryPort } from '../../src/execution/repositories.js';
import type { AttemptExecutionBackend } from '../../src/execution/attempt-execution-backend.js';

function persisted(attemptId: string, containerId: string): AttemptExecutionPersistenceRecord {
  return {
    attemptId, taskId: 'task', generationId: 'gen', subtaskId: 'subtask', workUnitId: 'worker',
    workspaceId: 'workspace', containerId, imageRef: 'image', imageId: 'sha256:image', status: 'running',
    leaseToken: 'lease', labels: {}, exitCode: null, resultCollectedAt: null, cleanupStatus: null,
    cleanupError: null, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
  };
}

describe('AttemptExecutionBackendReconciler', () => {
  it('removes orphans and marks missing durable sandboxes lost', async () => {
    const active = persisted('attempt-lost', 'missing-container');
    const updates: Array<[string, unknown]> = [];
    const repository = {
      listActive: () => [active],
      find: vi.fn(), findByContainerId: vi.fn(), create: vi.fn(),
      update: (id: string, changes: unknown) => { updates.push([id, changes]); },
    } as unknown as AttemptExecutionRepositoryPort;
    const backend = {
      listManaged: vi.fn().mockResolvedValue([{
        containerId: 'orphan', imageId: 'sha256:image', status: 'running', exitCode: null,
        labels: { 'io.metaclaw.attempt-id': 'unknown' },
      }]),
      stop: vi.fn(), remove: vi.fn(),
    } as unknown as AttemptExecutionBackend;
    const result = await new AttemptExecutionBackendReconciler(backend, repository).reconcile({ checkpoint: vi.fn() });

    expect(result.orphanContainerIds).toEqual(['orphan']);
    expect(result.lostAttempts).toEqual([active]);
    expect(updates).toEqual([['attempt-lost', expect.objectContaining({ status: 'lost', cleanupStatus: 'missing' })]]);
    expect(backend.stop).toHaveBeenCalledWith('orphan');
    expect(backend.remove).toHaveBeenCalledWith('orphan');
  });

  it('checkpoints and destroys a crash-left paused container', async () => {
    const active = persisted('attempt-paused', 'paused-container');
    const checkpoint = vi.fn();
    const repository = {
      listActive: () => [active], find: vi.fn(), findByContainerId: vi.fn(), create: vi.fn(), update: vi.fn(),
    } as unknown as AttemptExecutionRepositoryPort;
    const backend = {
      listManaged: vi.fn().mockResolvedValue([{
        containerId: 'paused-container', imageId: 'sha256:image', status: 'paused', exitCode: null, labels: {},
      }]), stop: vi.fn(), remove: vi.fn(),
    } as unknown as AttemptExecutionBackend;
    const result = await new AttemptExecutionBackendReconciler(backend, repository).reconcile({ checkpoint });

    expect(checkpoint).toHaveBeenCalledWith(active);
    expect(result.lostAttempts).toEqual([active]);
    expect(repository.update).toHaveBeenLastCalledWith('attempt-paused', expect.objectContaining({ status: 'removed' }));
  });
});
