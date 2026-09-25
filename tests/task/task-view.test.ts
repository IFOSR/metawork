import { describe, expect, it } from 'vitest';
import { projectTaskView, type TaskViewFacts } from '../../src/task/task-view.js';

const NOW = '2026-09-25T00:00:00.000Z';

function facts(overrides: Partial<TaskViewFacts> = {}): TaskViewFacts {
  return {
    task: { id: 'task_1', status: 'running', updatedAt: NOW },
    subtasks: [{ id: 'task_1_execute', status: 'running' }],
    dispatches: [{
      attemptId: 'attempt_1',
      subtaskId: 'task_1_execute',
      status: 'running',
      attemptKind: 'primary',
      createdAt: NOW,
      updatedAt: NOW,
    }],
    receipts: [],
    replanJobs: [],
    uncertainApplications: [],
    publications: [],
    completionResidue: [],
    pendingPermission: null,
    retryWakeAt: null,
    result: null,
    ...overrides,
  };
}

describe('unified TaskView projection', () => {
  it('reports executing only while an authorized Attempt is active', () => {
    const view = projectTaskView(facts());
    expect(view.phase).toBe('executing');
    expect(view.activeAttempt).toEqual({
      attemptId: 'attempt_1',
      subtaskId: 'task_1_execute',
      attemptKind: 'primary',
      ordinal: 1,
      lifecycle: 'running',
      outcome: null,
    });
    expect(view.nextAuthorizedAction).toBe('await_attempt_settlement');
  });

  it('never reports a running Task with no active Attempt as executing', () => {
    const view = projectTaskView(facts({
      subtasks: [{ id: 'task_1_execute', status: 'awaiting_decision' }],
      dispatches: [{
        attemptId: 'attempt_1',
        subtaskId: 'task_1_execute',
        status: 'terminal',
        attemptKind: 'primary',
        createdAt: NOW,
        updatedAt: NOW,
      }],
      receipts: [{
        attemptId: 'attempt_1',
        terminalState: 'heartbeat_lost',
        failure: null,
        completedAt: NOW,
      }],
    }));
    expect(view.lifecycle).toBe('executing');
    expect(view.phase).not.toBe('executing');
    expect(view.activeAttempt).toBeNull();
    expect(view.timestamps.lastAttemptSettledAt).toBe(NOW);
  });

  it('reports retrying when only a bounded retry wake exists', () => {
    const view = projectTaskView(facts({
      dispatches: [],
      retryWakeAt: '2026-09-25T00:05:00.000Z',
    }));
    expect(view.phase).toBe('retrying');
    expect(view.nextAuthorizedAction).toBe('await_retry_wake');
  });

  it('reports waiting_for_plan for a pending Replan Job without an attached client', () => {
    const view = projectTaskView(facts({
      dispatches: [{
        attemptId: 'attempt_1',
        subtaskId: 'task_1_execute',
        status: 'terminal',
        attemptKind: 'primary',
        createdAt: NOW,
        updatedAt: NOW,
      }],
      replanJobs: [{
        id: 'generation_replan_1',
        status: 'planning',
        generationId: 'generation_1',
        sourceRevision: 1,
        updatedAt: NOW,
      }],
    }));
    expect(view.phase).toBe('waiting_for_plan');
    expect(view.currentReplanJob?.id).toBe('generation_replan_1');
    expect(view.nextAuthorizedAction).toBe('await_planner_proposal');
    expect(view.blockingResidue).toContain('replan:generation_replan_1');
  });

  it('reports recovery_required for an uncertain Kernel application', () => {
    const view = projectTaskView(facts({
      dispatches: [],
      uncertainApplications: [{
        applicationId: 'decision_1',
        action: 'schedule_replan',
        errorSummary: 'transport uncertain',
        updatedAt: NOW,
      }],
    }));
    expect(view.phase).toBe('recovery_required');
    expect(view.currentRecovery?.applicationId).toBe('decision_1');
    expect(view.nextAuthorizedAction).toBe('resolve_uncertain_application');
  });

  it('reports publishing while publication residue remains', () => {
    const view = projectTaskView(facts({
      dispatches: [],
      publications: [{ id: 'publication_1', status: 'applying' }],
    }));
    expect(view.phase).toBe('publishing');
    expect(view.blockingResidue).toContain('publication:applying');
  });

  it('reports waiting_for_user for a pending permission request', () => {
    const view = projectTaskView(facts({
      dispatches: [],
      pendingPermission: { requestId: 'permission_1' },
    }));
    expect(view.phase).toBe('waiting_for_user');
    expect(view.nextAuthorizedAction).toBe('await_user_input');
  });

  it('keeps a blocked Task blocked when a Replan Job is still scheduled', () => {
    const view = projectTaskView(facts({
      task: { id: 'task_1', status: 'blocked', updatedAt: NOW },
      dispatches: [],
      replanJobs: [{
        id: 'generation_replan_1',
        status: 'planning',
        generationId: 'generation_1',
        sourceRevision: 1,
        updatedAt: NOW,
      }],
    }));
    expect(view.phase).toBe('blocked');
    expect(view.nextAuthorizedAction).toBe('explicit_resume_required');
  });

  it('reports completed only for a terminal Task with no residue', () => {
    const view = projectTaskView(facts({
      task: { id: 'task_1', status: 'done', updatedAt: NOW },
      dispatches: [],
      result: { resultId: 'result_1', completeness: 'complete', certification: 'certified' },
    }));
    expect(view.phase).toBe('completed');
    expect(view.nextAuthorizedAction).toBe('none');
    expect(view.result?.certification).toBe('certified');
  });

  it('reports queued for an admitted Task awaiting a Conversation slot', () => {
    const view = projectTaskView(facts({
      task: { id: 'task_1', status: 'ready', updatedAt: NOW },
      dispatches: [],
    }));
    expect(view.phase).toBe('queued');
    expect(view.nextAuthorizedAction).toBe('await_conversation_slot');
  });

  it('orders attempts and reports the active ordinal with settled outcomes', () => {
    const view = projectTaskView(facts({
      dispatches: [
        {
          attemptId: 'attempt_1',
          subtaskId: 'task_1_execute',
          status: 'terminal',
          attemptKind: 'primary',
          createdAt: '2026-09-25T00:00:00.000Z',
          updatedAt: '2026-09-25T00:01:00.000Z',
        },
        {
          attemptId: 'attempt_2',
          subtaskId: 'task_1_execute',
          status: 'running',
          attemptKind: 'fallback',
          createdAt: '2026-09-25T00:02:00.000Z',
          updatedAt: '2026-09-25T00:02:00.000Z',
        },
      ],
      receipts: [{
        attemptId: 'attempt_1',
        terminalState: 'heartbeat_lost',
        failure: null,
        completedAt: '2026-09-25T00:01:00.000Z',
      }],
    }));
    expect(view.activeAttempt?.attemptId).toBe('attempt_2');
    expect(view.activeAttempt?.ordinal).toBe(2);
    expect(view.subtaskStates).toEqual([
      { subtaskId: 'task_1_execute', state: 'executing' },
    ]);
  });
});
