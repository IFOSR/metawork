import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { KernelEffectOutboxRepo } from '../../src/storage/kernel-effect-outbox-repo.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';

const expected = { taskId: 'task', subtaskId: 'final', generationId: 'generation',
  graphRevision: 1, attemptId: 'primary', resultId: 'primary_safe' };
const envelope = { schemaVersion: 5, configurationRevision: 'revision', correlationId: 'control',
  causationId: null, occurredAt: '2026-11-04T12:49:09.473Z', sessionId: 'session', taskId: 'task' } as const;

/** Real durable workflow reproduces the old pending accept followed by user retry. */
describe('result decision recovery', () => {
  it.each(['retry', 'accept', 'accept_replay'] as const)(
    'settles an old implicit acceptance without effects, then admits explicit %s', async mode => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    db.prepare("INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at) VALUES ('revision', 'hash', 'native', 'now')").run();
    try {
      const store = new KernelWorkflowRepo(db);
      const outbox = new KernelEffectOutboxRepo(db);
      const snapshot: Extract<KernelSnapshot, { type: 'task_control' }> = {
        schemaVersion: 5, type: 'task_control', task: { id: 'task', status: 'needs_action' },
        generationId: expected.generationId, graphRevision: 1, subtasks: [],
        completionBlockedReasons: [], partialCancellation: false,
        uncertifiedResult: mode === 'accept_replay' ? null : expected, resultRetrySafe: true,
        ...(mode === 'accept_replay' ? { acceptedResult: expected } : {}),
      };
      const oldEvent = { ...envelope, id: 'old_observation', type: 'execution_result_observed' } as KernelEvent;
      const oldDecision = { schemaVersion: 5 as const, configurationRevision: 'revision',
        id: 'old_automatic_accept', eventId: oldEvent.id, reason: 'metadata-only defects',
        action: { type: 'accept_uncertified_result' as const, ...expected } };
      store.enqueue(oldEvent);
      store.issue(oldEvent.id, { ...envelope, id: oldDecision.id, eventId: oldEvent.id,
        eventType: oldEvent.type, subtaskId: 'final', attemptId: 'primary', event: oldEvent,
        snapshot, decision: oldDecision, action: oldDecision.action.type, reason: oldDecision.reason,
        authorizedBindings: [], bindingFingerprints: [], createdAt: envelope.occurredAt });
      const reconcile = vi.fn((input: { facts: () => unknown }) => input.facts());
      const updateSubtask = vi.fn();
      const recoverDue = vi.fn(async () => true);
      const runtime = new KernelExecutionRuntime({
        taskStateAuthority: { reconcile },
        subtaskRepo: { findById: () => ({ id: 'final', status: 'awaiting_decision' }), updateStatus: updateSubtask },
        taskRuntimeService: { findTask: () => ({ id: 'task', status: 'needs_action', goal: 'report',
          ownerPlannerSessionId: 'session', conversationId: null }) },
        workGraphRevisionRepo: { findActive: () => ({ generationId: expected.generationId, revision: 1 }) },
        cancellationCoordinator: { buildSnapshot: () => snapshot },
        controlKernel: new ControlKernel(), kernelWorkflowStore: store, effectOutboxRepo: outbox,
        callbacks: { appendExecutionTrace: vi.fn() }, dispatchItemRepo: {}, maxConcurrentAttempts: 4,
      } as never);
      runtime.recoverDue = recoverDue;
      const event = { ...envelope, id: 'user_control', type: mode === 'retry' ? 'task_result_retry_requested' : 'partial_result_acceptance_requested', expectedResult: expected } as const;
      const receipt = await (runtime as unknown as {
        submitTaskControlEvent(event: KernelEvent): Promise<{ affectedSubtaskIds: string[] }>;
      }).submitTaskControlEvent(event);
      expect(receipt.affectedSubtaskIds).toEqual(['final']);
      expect(reconcile).toHaveBeenCalledTimes(1);
      const effects = outbox.listByTaskAndType('task', 'task_result_continuation');
      expect(effects).toHaveLength(1);
      expect(effects[0]?.payload.action).toMatchObject({ type: mode === 'retry' ? 'retry_uncertified_result' : 'accept_uncertified_result', ...expected });
      expect(store.countByApplicationStatus()).toMatchObject({ pending: 0, applying: 0, uncertain: 0, applied: 2 });
      const old = db.prepare('SELECT error_summary FROM kernel_decision_applications WHERE decision_id = ?')
        .get(oldDecision.id) as { error_summary: string };
      expect(old.error_summary).toContain('rejected_without_effect:result_decision_requires_user');
      if (mode === 'retry') {
        expect(updateSubtask).toHaveBeenCalledTimes(1);
        expect(updateSubtask).toHaveBeenCalledWith('final', 'ready', { error: null });
      } else {
        expect(updateSubtask).not.toHaveBeenCalled();
      }
      expect(recoverDue).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});
