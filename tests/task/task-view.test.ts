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
