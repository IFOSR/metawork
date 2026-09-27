import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { RetryWakeWorker } from '../../src/account/retry-wake-worker.js';
import { RetryWakeRepo, type RetryWakeRecord } from '../../src/storage/retry-wake-repo.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { ConfigurationRevisionRepo } from '../../src/storage/configuration-revision-repo.js';

const binding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-harness',
  providerRef: 'openai',
  modelRef: 'codex-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision: 'revision-1',
};

function wake(): RetryWakeRecord {
  return {
    wakeId: 'wake-1',
    taskId: 'task-1',
    subtaskId: 'subtask-1',
    generationId: 'generation-1',
    sourceDecisionId: 'decision-1',
    sourceAttemptId: 'attempt-1',
    configurationRevision: 'revision-1',
    bindingFingerprint: 'fingerprint-1',
    authorizedBindingJson: JSON.stringify(binding),
    resumeAt: '2026-09-27T00:00:00.000Z',
    status: 'armed',
    timerEventId: null,
    consumedDecisionId: null,
    createdAt: '2026-09-26T23:59:00.000Z',
    updatedAt: '2026-09-26T23:59:00.000Z',
  };
}

describe('RetryWakeWorker', () => {
  it('delivers one deterministic timer and replays a fired wake after a crash', async () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      new ConfigurationRevisionRepo(db).ensure({
        revisionId: 'revision-1',
        contentHash: 'sha256:test',
        sourceKind: 'schema-30-import',
        importedAt: '2026-09-26T23:00:00.000Z',
      });
      new TaskEngine(new TaskRepo(db), '/tmp/metawork-retry-wake-test').create({
        id: 'task-1',
        title: 'retry',
        goal: 'retry',
      });
      const retryWakeRepo = new RetryWakeRepo(db);
      const workflow = new KernelWorkflowRepo(db);
      retryWakeRepo.arm(wake());
      const processTimer = vi.fn().mockResolvedValue(undefined);
      let parentApplied = false;
      const worker = new RetryWakeWorker({
        retryWakeRepo,
        kernelWorkflowStore: {
          enqueue: workflow.enqueue.bind(workflow),
          isDecisionApplied: () => parentApplied,
        },
        findSessionId: () => 'session-1',
        processTimer,
        now: () => '2026-09-27T00:01:00.000Z',
      });

      expect(await worker.run()).toBe(0);
      expect(retryWakeRepo.findById('wake-1')?.status).toBe('armed');
      expect(processTimer).not.toHaveBeenCalled();

      parentApplied = true;
      expect(await worker.run()).toBe(1);
      expect(await worker.run()).toBe(0);
      expect(processTimer).toHaveBeenCalledTimes(1);
      expect(processTimer.mock.calls[0]?.[0]).toMatchObject({
        id: 'retry_timer_wake-1',
        type: 'timer_tick',
        sourceDecisionId: 'decision-1',
        scheduledFor: '2026-09-27T00:00:00.000Z',
        retry: {
          wakeId: 'wake-1',
          generationId: 'generation-1',
          configurationRevision: 'revision-1',
          sourceAttemptId: 'attempt-1',
        },
      });
      expect(retryWakeRepo.findById('wake-1')).toMatchObject({
        status: 'fired',
        timerEventId: 'retry_timer_wake-1',
      });

      const crashWake = {
        ...wake(),
        wakeId: 'wake-2',
        sourceDecisionId: 'decision-2',
        timerEventId: null,
      };
      retryWakeRepo.arm(crashWake);
      retryWakeRepo.claimDueWake(
        'wake-2',
        '2026-09-27T00:01:00.000Z',
        '2026-09-27T00:01:00.000Z',
      );
      expect(await worker.run()).toBe(1);
      expect(processTimer).toHaveBeenCalledTimes(2);
      expect(workflow.findEvent('retry_timer_wake-2')).toMatchObject({
        type: 'timer_tick',
        retry: { wakeId: 'wake-2' },
      });
    } finally {
      db.close();
    }
  });

  it('fails closed when the source Decision has no resolvable session', async () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      new ConfigurationRevisionRepo(db).ensure({
        revisionId: 'revision-1',
        contentHash: 'sha256:test',
        sourceKind: 'schema-30-import',
        importedAt: '2026-09-26T23:00:00.000Z',
      });
      new TaskEngine(new TaskRepo(db), '/tmp/metawork-retry-wake-test').create({
        id: 'task-1',
        title: 'retry',
        goal: 'retry',
      });
      const retryWakeRepo = new RetryWakeRepo(db);
      retryWakeRepo.arm(wake());
      const workflow = new KernelWorkflowRepo(db);
      const worker = new RetryWakeWorker({
        retryWakeRepo,
        kernelWorkflowStore: {
          enqueue: workflow.enqueue.bind(workflow),
          isDecisionApplied: () => true,
        },
        findSessionId: () => null,
        processTimer: vi.fn(),
        now: () => '2026-09-27T00:01:00.000Z',
      });

      expect(await worker.run()).toBe(0);
      expect(retryWakeRepo.findById('wake-1')?.status).toBe('recovery_required');
    } finally {
      db.close();
    }
  });
});
