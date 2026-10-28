import { describe, expect, it } from 'vitest';
import {
  buildTaskDashboard,
  formatTaskDashboard,
  sanitizeDetail,
  type TaskDashboardFacts,
  type TaskDashboardTaskFact,
} from '../../src/commands/task-dashboard-view.js';

const NOW = '2026-10-28T04:10:00.000Z';

function taskFact(overrides: Partial<TaskDashboardTaskFact> & {
  status?: NonNullable<TaskDashboardTaskFact['view']>['status'];
} = {}): TaskDashboardTaskFact {
  const { status = 'running', ...rest } = overrides;
  return {
    taskId: rest.taskId ?? 'task_a',
    title: rest.title ?? '生成 PPT',
    status: rest.status ?? 'running',
    conversationId: rest.conversationId ?? 'conv_current',
    conversationTitle: rest.conversationTitle ?? null,
    createdAt: rest.createdAt ?? '2026-10-28T04:05:00.000Z',
    updatedAt: rest.updatedAt ?? '2026-10-28T04:09:00.000Z',
    view: rest.view === null ? null : {
      status,
      reasonCode: rest.view?.reasonCode ?? 'none',
      reasonMessage: rest.view?.reasonMessage ?? '',
      phase: rest.view?.phase ?? null,
      pendingActionKinds: rest.view?.pendingActionKinds ?? [],
      cleanup: rest.view?.cleanup ?? { state: 'none', objects: [] },
    },
  };
}

function facts(input: {
  tasks: TaskDashboardTaskFact[];
  active?: number;
  limit?: number;
  localActive?: number;
  foreignActive?: number;
  currentConversationId?: string | null;
}): TaskDashboardFacts {
  const active = input.active ?? 0;
  const localActive = input.localActive ?? active;
  return {
    now: NOW,
    currentConversationId: input.currentConversationId === undefined ? 'conv_current' : input.currentConversationId,
    capacity: {
      active,
      limit: input.limit ?? 2,
      localActive,
      foreignActive: input.foreignActive ?? active - localActive,
    },
    tasks: input.tasks,
  };
}

describe('task dashboard view', () => {
  it('renders the six-state label instead of a legacy bucket', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({ title: '半导体研究', status: 'running' })],
      active: 1,
    }));
    const text = formatTaskDashboard(model);
    expect(model.executing).toHaveLength(1);
    expect(text).toContain('[执行中] 半导体研究');
    expect(text).toContain('执行名额 1/2 使用中');
    expect(text).not.toContain('活跃');
    expect(text).not.toContain('暂停');
    expect(text).not.toContain('完成');
  });

  it('explains why a queued Task waits, including other-Workspace capacity', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({
        taskId: 'task_queued', title: '减重 PPT', status: 'queued',
        view: { status: 'queued', reasonCode: 'waiting_for_capacity', reasonMessage: '', phase: null,
          pendingActionKinds: [], cleanup: { state: 'none', objects: [] } },
      })],
      active: 2,
      localActive: 1,
      foreignActive: 1,
    }));
    const text = formatTaskDashboard(model);
    expect(model.queued).toHaveLength(1);
    expect(text).toContain('排队 1');
    expect(text).toContain('等待执行名额');
    expect(text).toContain('其他 Workspace 占用');
    expect(text).toContain('执行名额 2/2 使用中（本 Workspace 1 · 其他 Workspace 1）');
  });

  it('counts a needs_action Task once and only under the action section', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({
        taskId: 'task_blocked', title: '生成并校验减重方案 PPT', status: 'needs_action',
        view: { status: 'needs_action', reasonCode: 'input_required', reasonMessage: '', phase: null,
          pendingActionKinds: ['provide_input'], cleanup: { state: 'none', objects: [] } },
      })],
      active: 0,
    }));
    const text = formatTaskDashboard(model);
    expect(model.needsAction).toHaveLength(1);
    expect(model.executing).toHaveLength(0);
    expect(text).toContain('需要你处理 1');
    expect(text).toContain('需要你补充信息或确认');
    expect(text).toContain('/task resume task_blocked');
    expect(text).toContain('/task cancel task_blocked');
  });

  it('offers the acceptance action when the Task waits for a result decision', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({
        taskId: 'task_accept', title: '交付报告', status: 'needs_action',
        view: { status: 'needs_action', reasonCode: 'result_acceptance_required', reasonMessage: '',
          phase: null, pendingActionKinds: ['accept_result'], cleanup: { state: 'none', objects: [] } },
      })],
    }));
    expect(model.needsAction[0]?.actions).toContain('/task accept-result task_accept');
    expect(model.needsAction[0]?.actions.some(action => action.startsWith('/task resume'))).toBe(false);
  });

  it('never renders internal identifiers or residue category names', () => {
    const longId = 'task_plan_event_proposal_43fdf5b20597574e4558ba0ff9aa5c94f776201ba9752e7e687c7251a85f5cd9_r1_build-pptx';
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({
        taskId: 'task_blocked', title: '生成并校验减重方案 PPT', status: 'needs_action',
        view: {
          status: 'needs_action',
          reasonCode: 'input_required',
          reasonMessage: `no runnable Subtask while work remains; dependency materialization failed: ${longId} -> ${longId}; source is done but the edge-scoped handoff is missing`,
          phase: null,
          pendingActionKinds: ['provide_input'],
          cleanup: { state: 'pending', objects: ['kernel_application'] },
        },
      })],
    }));
    const text = formatTaskDashboard(model);
    expect(text).not.toContain('task_plan_event_proposal_');
    expect(text).not.toContain('kernel_application');
    expect(text).toContain('正在安全收尾：上一次系统操作');
    // An English runtime diagnostic is not user copy: it stays in the detail view.
    expect(text).not.toContain('dependency materialization failed');
    expect(text).not.toContain('细节：');
  });

  it('renders a bounded detail when the producer wrote user-facing copy', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({
        taskId: 'task_input', title: '生成 PPT', status: 'needs_action',
        view: { status: 'needs_action', reasonCode: 'input_required',
          reasonMessage: '上游 PPT 提纲已就绪，请确认是否沿用当前大纲继续生成',
          phase: null, pendingActionKinds: ['provide_input'], cleanup: { state: 'none', objects: [] } },
      })],
    }));
    expect(formatTaskDashboard(model)).toContain('细节：上游 PPT 提纲已就绪');
  });

  it('keeps only the three most recent finished Tasks', () => {
    const model = buildTaskDashboard(facts({
      tasks: [
        taskFact({ taskId: 'task_1', title: '最早', status: 'succeeded', updatedAt: '2026-10-28T01:00:00.000Z' }),
        taskFact({ taskId: 'task_2', title: '较新', status: 'failed', updatedAt: '2026-10-28T03:00:00.000Z' }),
        taskFact({ taskId: 'task_3', title: '最新', status: 'cancelled', updatedAt: '2026-10-28T04:00:00.000Z' }),
        taskFact({ taskId: 'task_4', title: '中间', status: 'succeeded', updatedAt: '2026-10-28T02:00:00.000Z' }),
      ],
    }));
    expect(model.finished.map(row => row.title)).toEqual(['最新', '较新', '中间']);
  });

  it('marks Tasks owned by another Conversation of the same Workspace', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({
        taskId: 'task_other', title: '别的会话的任务', status: 'running',
        conversationId: 'conv_other', conversationTitle: '半导体复盘',
      })],
      active: 1,
    }));
    expect(formatTaskDashboard(model)).toContain('会话「半导体复盘」');
  });

  it('degrades to an empty state without inventing a Task', () => {
    const text = formatTaskDashboard(buildTaskDashboard(facts({ tasks: [] })));
    expect(text).toContain('当前没有任务');
    expect(text).not.toContain('需要你处理');
  });

  it('falls back to the persisted status when no projection is available', () => {
    const model = buildTaskDashboard(facts({
      tasks: [taskFact({ taskId: 'task_raw', title: '无投影', status: 'running', view: null })],
    }));
    expect(model.executing).toHaveLength(1);
    expect(model.executing[0]?.reason).toBe('');
  });
});

describe('sanitizeDetail', () => {
  it('strips long identifiers, digests and collapses whitespace', () => {
    expect(sanitizeDetail(
      'failed at task_plan_event_proposal_43fdf5b2059\n sha256:abc123def456 because   reasons',
    )).toBe('failed at … … because reasons');
  });

  it('returns null for an empty diagnostic', () => {
    expect(sanitizeDetail('   ')).toBeNull();
  });

  it('bounds long diagnostics with an ellipsis', () => {
    const sanitized = sanitizeDetail('word '.repeat(120), 20);
    expect(sanitized?.length).toBeLessThanOrEqual(21);
    expect(sanitized?.endsWith('…')).toBe(true);
  });
});
