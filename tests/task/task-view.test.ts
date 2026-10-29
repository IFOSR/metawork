import { describe, expect, it } from 'vitest';
import { projectTaskView, type TaskViewFacts } from '../../src/task/task-view.js';
import {
  createTaskReason,
  EMPTY_TASK_STATE_DETAIL,
  type TaskStateDetail,
  type TaskStatus,
} from '../../src/task/task-state.js';

const NOW = '2026-10-22T00:00:00.000Z';

function stateDetail(overrides: Partial<TaskStateDetail> = {}): TaskStateDetail {
  return { ...EMPTY_TASK_STATE_DETAIL, ...overrides };
}

function facts(overrides: Partial<TaskViewFacts> = {}): TaskViewFacts {
  return {
    task: {
      id: 'task_1',
      status: 'running',
      stateVersion: 4,
      stateDetail: stateDetail({
        reason: createTaskReason('none', ''),
        phase: 'executing',
      }),
      updatedAt: NOW,
    },
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

function withStatus(status: TaskStatus, detail: TaskStateDetail = stateDetail()) {
  return facts({ task: { id: 'task_1', status, stateVersion: 7, stateDetail: detail, updatedAt: NOW } });
}

describe('TaskView v2 projection', () => {
  it('reads the committed status and version instead of re-deriving a conclusion', () => {
    for (const status of ['queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled'] as const) {
      const view = projectTaskView(withStatus(status));
      expect(view.status).toBe(status);
      expect(view.state.status).toBe(status);
      expect(view.state.stateVersion).toBe(7);
    }
  });

  it('never turns a needs_action Task into executing because an Attempt is active', () => {
    const view = projectTaskView(withStatus('needs_action', stateDetail({
      reason: createTaskReason('result_acceptance_required', '需要接受结果'),
      pendingActions: [{
        actionId: 'accept:a',
        kind: 'accept_result',
        label: '接受结果',
        reason: createTaskReason('result_acceptance_required', '需要接受结果'),
        result: null,
      }],
    })));
    expect(view.status).toBe('needs_action');
    expect(view.nextAuthorizedAction).toBe('accept_result');
    expect(view.pendingActions).toHaveLength(1);
  });

  it('projects the active Attempt as detail, not as a status', () => {
    const view = projectTaskView(facts());
    expect(view.status).toBe('running');
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

  it('reports the one phase and next action from the committed detail', () => {
    const retrying = projectTaskView(withStatus('running', stateDetail({
      phase: 'retrying',
      nextWakeAt: '2026-10-22T00:05:00.000Z',
    })));
    expect(retrying.nextAuthorizedAction).toBe('await_retry_wake');
    expect(retrying.state.nextWakeAt).toBe('2026-10-22T00:05:00.000Z');

    const publishing = projectTaskView(withStatus('running', stateDetail({ phase: 'publishing' })));
    expect(publishing.nextAuthorizedAction).toBe('await_publication');

    const queued = projectTaskView(withStatus('queued', stateDetail({
      reason: createTaskReason('waiting_for_capacity', '等待执行名额'),
    })));
    expect(queued.nextAuthorizedAction).toBe('await_conversation_slot');

    const waiting = projectTaskView(withStatus('needs_action'));
    expect(waiting.nextAuthorizedAction).toBe('await_user_input');
    expect(waiting.recoveryDiagnosis).toBeNull();
  });

  it('surfaces the failure reason and cleanup for a failed Task', () => {
    const view = projectTaskView(withStatus('failed', stateDetail({
      reason: createTaskReason('port_in_use', '端口已被占用。', ['service:dev']),
      cleanup: { state: 'pending', objects: ['dispatch'], reason: '正在安全停止' },
    })));
    expect(view.status).toBe('failed');
    expect(view.state.reason.code).toBe('port_in_use');
    expect(view.explanation).toContain('端口已被占用');
    expect(view.cleanup.objects).toContain('dispatch');
    expect(view.nextAuthorizedAction).toBe('none');
  });

  it('keeps terminal Tasks terminal for every operational residue', () => {
    const view = projectTaskView(facts({
      task: {
        id: 'task_1',
        status: 'cancelled',
        stateVersion: 9,
        stateDetail: stateDetail({ reason: createTaskReason('user_cancelled', '用户取消了任务。') }),
        updatedAt: NOW,
      },
      uncertainApplications: [{ applicationId: 'app_1', action: 'dispatch_batch', errorSummary: null, updatedAt: NOW }],
    }));
    expect(view.status).toBe('cancelled');
    expect(view.recoveryDiagnosis).toBe('uncertain_application');
    expect(view.blockingResidue).toContain('application:app_1');
    expect(view.nextAuthorizedAction).toBe('none');
  });

  it('reports recovery diagnosis from the committed reason, not a guessed phase', () => {
    const view = projectTaskView(withStatus('needs_action', stateDetail({
      reason: createTaskReason('no_authorized_driver', '没有可以继续的授权工作'),
    })));
    expect(view.status).toBe('needs_action');
    expect(view.recoveryDiagnosis).toBe('no_authorized_driver');
    expect(view.nextAuthorizedAction).toBe('await_user_input');
  });
});

describe('ordinary in-place completion is not a user decision', () => {
  it('projects a certified in-place edit as a finished task without an accept action', () => {
    const view = projectTaskView(facts({
      task: {
        id: 'task_1',
        status: 'succeeded',
        stateVersion: 9,
        stateDetail: stateDetail({
          reason: createTaskReason('none', '用户要求的必需工作已全部完成。'),
          requiredWork: [
            { key: 'execution:node', kind: 'execution', label: '修改文件', state: 'completed', reason: null },
          ],
        }),
        updatedAt: NOW,
      },
      subtasks: [{ id: 'task_1_execute', status: 'done' }],
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
        subtaskId: 'task_1_execute',
        terminalState: 'completed',
        accepted: true,
        failureCode: null,
      }] as never,
    }));
    expect(view.status).toBe('succeeded');
    // The re-request/acceptance pair belongs only to an uncertified or partial
    // result; a certified In-place edit is delivered as-is (2026-10-27 §6).
    expect(view.nextAuthorizedAction).toBe('none');
    expect(view.state.pendingActions).toEqual([]);
  });
});

describe('live pending result actions', () => {
  const expected = {
    taskId: 'task_1',
    generationId: 'generation_1',
    graphRevision: 1,
    subtaskId: 'task_1_execute',
    attemptId: 'attempt_safe',
    resultId: 'result_safe',
  };

  it('offers accept and retry even when the persisted detail predates the result', () => {
    // A failed metadata correction left the state detail without actions, but
    // the safe result is still acceptable. The projection must not answer with
    // a generic resume.
    const view = projectTaskView(facts({
      task: {
        id: 'task_1',
        status: 'needs_action',
        stateVersion: 5,
        stateDetail: stateDetail({
          reason: createTaskReason('result_acceptance_required', '结果已安全保存'),
          pendingActions: [],
        }),
        updatedAt: NOW,
      },
      subtasks: [{ id: 'task_1_execute', status: 'awaiting_decision' }],
      dispatches: [],
      pendingDecision: {
        owner: 'user',
        reason: 'uncertified_result',
        resultId: 'result_safe',
        attemptId: 'attempt_safe',
        expectedResult: expected,
        actions: ['accept_result', 'retry_attempt'],
      },
    }));

    expect(view.nextAuthorizedAction).toBe('accept_result');
    expect(view.pendingActions.map(action => action.kind)).toEqual(['accept_result', 'retry_attempt']);
    expect(view.state.pendingActions.map(action => action.kind)).toEqual(['accept_result', 'retry_attempt']);
    expect(view.pendingActions[0]?.result).toEqual(expected);
  });

  it('keeps a persisted recovery action when the same kinds are already present', () => {
    const persisted = {
      actionId: 'accept:candidate',
      kind: 'accept_result' as const,
      label: '接受候选变更并发布到工作区',
      reason: createTaskReason('input_required', '候选变更等待接受'),
      result: null,
      publicationId: 'publication_1',
    };
    const view = projectTaskView(facts({
      task: {
        id: 'task_1',
        status: 'needs_action',
        stateVersion: 5,
        stateDetail: stateDetail({ pendingActions: [persisted] }),
        updatedAt: NOW,
      },
      subtasks: [{ id: 'task_1_execute', status: 'awaiting_decision' }],
      dispatches: [],
      pendingDecision: {
        owner: 'user',
        reason: 'uncertified_result',
        resultId: 'result_safe',
        attemptId: 'attempt_safe',
        expectedResult: expected,
        actions: ['accept_result'],
      },
    }));
    expect(view.pendingActions).toHaveLength(1);
    expect(view.pendingActions[0]?.publicationId).toBe('publication_1');
  });

  it('projects no action when there is no live pending decision', () => {
    const view = projectTaskView(facts({
      task: {
        id: 'task_1',
        status: 'needs_action',
        stateVersion: 5,
        stateDetail: stateDetail({ pendingActions: [] }),
        updatedAt: NOW,
      },
      subtasks: [{ id: 'task_1_execute', status: 'awaiting_decision' }],
      dispatches: [],
    }));
    expect(view.pendingActions).toEqual([]);
    expect(view.nextAuthorizedAction).toBe('await_user_input');
  });
});
