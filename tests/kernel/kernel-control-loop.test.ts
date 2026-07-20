import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelDecision, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { KernelControlLoop, type KernelDecisionLedger, type KernelRuntime } from '../../src/kernel/kernel-control-loop.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';

const event: KernelEvent = {
  schemaVersion: 1, type: 'plan_proposed', id: 'event_1', correlationId: 'request_1', causationId: null,
  occurredAt: '2026-07-20T00:00:00.000Z', sessionId: 'session_1',
  proposal: {
    id: 'plan_1', schemaVersion: 4, action: 'direct_reply', confidence: 1, reason: 'answer',
    clarificationQuestion: null, response: { directReply: 'done' },
    task: { binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null, includeRecentConversationContext: false, priority: null },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] }, workGraph: null, source: 'codex-planner',
  },
};

const snapshot: KernelSnapshot = {
  schemaVersion: 1, type: 'plan_admission', tasks: [], runningTaskId: null,
  executorCatalog: getPlannerExecutorCatalog(), executorStatuses: [], v4WorkGraphTaskIds: [], eligibleContextRefKeys: [],
};

describe('KernelControlLoop', () => {
  it('persists before apply and does not reapply a duplicate event', async () => {
    const order: string[] = [];
    const eventIds = new Set<string>();
    const ledger: KernelDecisionLedger = {
      issue(record) {
        order.push(`issue:${record.eventId}`);
        if (eventIds.has(record.eventId)) return false;
        eventIds.add(record.eventId);
        return true;
      },
    };
    const runtime: KernelRuntime = {
      async apply(decision: KernelDecision) {
        order.push(`apply:${decision.eventId}`);
        return null;
      },
    };
    const loop = new KernelControlLoop({ kernel: new ControlKernel(), buildSnapshot: () => snapshot, ledger, runtime });

    await loop.run(event);
    await loop.run(event);

    expect(order).toEqual(['issue:event_1', 'apply:event_1', 'issue:event_1']);
  });

  it('persists Task and Subtask identities derived by a dispatch decision', async () => {
    const dispatchEvent: KernelEvent = {
      schemaVersion: 1,
      type: 'dispatch_requested',
      id: 'dispatch_event_1',
      correlationId: 'request_1',
      causationId: null,
      occurredAt: '2026-07-20T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      reason: 'initial dispatch',
    };
    const dispatchSnapshot: KernelSnapshot = {
      schemaVersion: 1,
      type: 'dispatch',
      task: { id: 'task_1', status: 'running' },
      runningTaskId: 'task_1',
      graphState: 'ready',
      subtasks: [{
        id: 'subtask_1', taskId: 'task_1', status: 'ready', preferredAgentClassList: ['codex-cli'],
      }],
      readyFrontier: ['subtask_1'],
      attemptedAgentClasses: [],
      executorStatuses: [{
        agentClassName: 'codex-cli', classHealth: 'error', recentAttempts: [],
        updatedAt: '2026-07-20T00:00:00.000Z',
      }],
      correctionSupportedAgentClasses: ['codex-cli'],
    };
    let persisted: Parameters<KernelDecisionLedger['issue']>[0] | null = null;
    const loop = new KernelControlLoop({
      kernel: new ControlKernel(),
      buildSnapshot: () => dispatchSnapshot,
      ledger: { issue: record => { persisted = record; return true; } },
      runtime: { apply: async () => null },
    });

    const [decision] = await loop.run(dispatchEvent);

    expect(decision.action).toEqual({ type: 'wait_for_capacity', taskId: 'task_1', subtaskId: 'subtask_1' });
    expect(persisted).toMatchObject({ taskId: 'task_1', subtaskId: 'subtask_1' });
  });
});
