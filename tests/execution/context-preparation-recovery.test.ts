import { describe, expect, it } from 'vitest';
import { decideFailure } from '../../src/execution/failure-retry-policy.js';
import type { ControlEvent, ControlSnapshot } from '../../src/control/control-contracts.js';

describe('Context preparation recovery', () => {
  const event = { schemaVersion: 5, id: 'event', configurationRevision: 'config', taskId: 'task',
    subtaskId: 'subtask', attemptId: 'attempt', attemptKind: 'primary', type: 'execution_outcome',
    occurredAt: '2026-11-11T00:00:00Z', terminalKind: 'failed',
    failure: { kind: 'capability_mismatch', scope: 'task', code: 'memory_asset_not_found', summary: 'memory replaced',
      stage: 'context_preparation', attemptStarted: false, externalSideEffect: false },
  } as Extract<ControlEvent, { type: 'execution_outcome' }>;
  const snapshot = { type: 'dispatch', task: { id: 'task', status: 'running' },
    subtasks: [{ id: 'subtask', status: 'ready' }], automaticRecoveryAllowed: true,
    automaticReplansUsed: 0, recoverySafety: 'read_only', generationId: 'gen', graphRevision: 1,
  } as Extract<ControlSnapshot, { type: 'dispatch' }>;

  it.each(['memory_asset_not_found', 'memory_revision_changed', 'memory_not_in_recall_snapshot',
    'memory_not_authorized', 'task_resource_not_authorized'])('refreshes %s without choosing another Executor', code => {
    expect(decideFailure({ ...event, failure: { ...event.failure!, code } }, snapshot).action)
      .toMatchObject({ type: 'queue_generation_replan', taskId: 'task', generationId: 'gen', sourceRevision: 1 });
  });
  it('stops after one automatic replan and names the actual context problem', () => {
    expect(decideFailure(event, { ...snapshot, automaticReplansUsed: 1 })).toMatchObject({
      action: { type: 'block_work', blockerKind: 'system' }, reason: expect.stringContaining('memory_asset_not_found'),
    });
  });
  it('preserves cancellation and external-effect fences', () => {
    expect(decideFailure(event, { ...snapshot, task: { ...snapshot.task!, status: 'cancelled' } }).action.type).toBe('no_op');
    expect(decideFailure(event, { ...snapshot, automaticRecoveryAllowed: false }).action.type).toBe('block_work');
    expect(decideFailure(event, { ...snapshot, recoverySafety: 'external_non_idempotent' }).action.type).toBe('block_work');
  });
});
