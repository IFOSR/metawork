import { describe, expect, it } from 'vitest';
import {
  ExecutionProjector,
  type ExecutionProjectorDeps,
} from '../../src/management/execution-projector.js';
import type { Subtask, Task } from '../../src/core/types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: '测试任务',
    goal: '',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 'sub_1',
    taskId: 'task_1',
    graphRevision: 1,
    generationId: 'gen_1',
    title: '子任务',
    goal: '',
    status: 'ready',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: [],
    executorBindings: [],
    deliveryKind: 'edit',
    acceptance: [],
    riskLevel: 'low',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProjector(overrides: Partial<ExecutionProjectorDeps> = {}): ExecutionProjector {
  return new ExecutionProjector({
    subtaskRepo: { listByTask: () => [] },
    receiptRepo: { listByTask: () => [] },
    decisionRepo: { listTimelineByTask: () => [] },
    publicationRepo: { listIntegratedByTaskIds: () => [], hasBlockingResidue: () => false },
    attemptRuntimeRepo: { find: () => null },
    dispatchItemRepo: { listByTask: () => [] },
    ...overrides,
  } as unknown as ExecutionProjectorDeps);
}

describe('ExecutionProjector', () => {
  it('空 task 所有阶段 pending', () => {
    const timeline = makeProjector().project(makeTask());
    expect(timeline.stages.map(stage => [stage.phase, stage.status])).toEqual([
      ['planning', 'pending'],
      ['authorization', 'pending'],
      ['execution', 'pending'],
      ['verification', 'pending'],
      ['delivery', 'pending'],
    ]);
  });

  it('有 subtasks 时 planning done 且 proposal 含依赖', () => {
    const subtasks = [
      makeSubtask({ id: 'sub_1', title: '写配置', status: 'done' }),
      makeSubtask({
        id: 'sub_2',
        title: '写脚本',
        status: 'ready',
        dependencies: [{ fromSubtaskId: 'sub_1', requiredItems: [] }],
      }),
    ];
    const timeline = makeProjector({
      subtaskRepo: { listByTask: () => subtasks },
    }).project(makeTask());

    const planning = timeline.stages[0];
    expect(planning.status).toBe('done');
    expect(planning.proposal?.subtasks).toEqual(['写配置', '写脚本']);
    expect(planning.proposal?.dependencies).toEqual([['sub_1', 'sub_2']]);
  });

  it('有 decisions 时 authorization done', () => {
    const timeline = makeProjector({
      decisionRepo: {
        listTimelineByTask: () => [
          { action: 'authorize', subtaskId: 'sub_1', taskId: 'task_1', reason: '材料齐全' },
        ],
      },
    }).project(makeTask());

    const authorization = timeline.stages[1];
    expect(authorization.status).toBe('done');
    expect(authorization.decisions?.[0]).toEqual({
      type: 'authorize',
      subtask: 'sub_1',
      reason: '材料齐全',
    });
  });

  it('execution 阶段聚合 subtask 状态和 executor', () => {
    const subtasks = [
      makeSubtask({ id: 'sub_1', title: '写配置', status: 'done' }),
      makeSubtask({ id: 'sub_2', title: '写脚本', status: 'running' }),
    ];
    const receipts = [
      {
        attemptId: 'attempt_1',
        subtaskId: 'sub_1',
        agentClassName: 'codex-cli',
        terminalState: 'completed',
        errorCode: null,
        errorDetail: null,
        verification: { warnings: [], violations: [] },
      },
    ];
    const timeline = makeProjector({
      subtaskRepo: { listByTask: () => subtasks },
      receiptRepo: { listByTask: () => receipts },
      attemptRuntimeRepo: {
        find: attemptId => attemptId === 'attempt_1'
          ? { progress: { kind: 'log', text: 'Running focused tests' } }
          : null,
      },
    }).project(makeTask());

    const execution = timeline.stages[2];
    expect(execution.status).toBe('running');
    const sub1 = execution.subtasks?.find(subtask => subtask.id === 'sub_1');
    expect(sub1?.executor).toBe('codex-cli');
    expect(sub1?.attempts[0]?.result).toBe('success');
    expect(sub1?.attempts[0]?.progress).toEqual({ kind: 'log', text: 'Running focused tests' });
  });

  it('projects active dispatch progress before a terminal receipt exists', () => {
    const subtasks = [
      makeSubtask({ id: 'sub_1', title: '研究主力合约', status: 'running' }),
    ];
    const timeline = makeProjector({
      subtaskRepo: { listByTask: () => subtasks },
      dispatchItemRepo: {
        listByTask: () => [{
          attemptId: 'attempt_running',
          subtaskId: 'sub_1',
          status: 'running',
          attemptKind: 'primary',
          authorizedBinding: { agentClassRef: 'pi-agent' },
          launchStartedAt: '2026-08-17T08:00:00.000Z',
          updatedAt: '2026-08-17T08:00:04.000Z',
        }],
      },
      attemptRuntimeRepo: {
        find: () => ({
          progress: {
            kind: 'log',
            text: '正在整理四维度趋势数据',
            history: [
              {
                kind: 'status',
                text: '读取市场数据',
                occurredAt: '2026-08-17T08:00:01.000Z',
              },
              {
                kind: 'log',
                text: '正在整理四维度趋势数据',
                occurredAt: '2026-08-17T08:00:04.000Z',
              },
            ],
          },
        }),
      },
    }).project(makeTask());

    const attempt = timeline.stages[2].subtasks?.[0]?.attempts[0];
    expect(attempt).toMatchObject({
      attemptId: 'attempt_running',
      attemptKind: 'primary',
      attemptOrdinal: 1,
      attemptLabel: '主执行',
      displayStatus: '执行中',
      result: 'running',
      progress: { text: '正在整理四维度趋势数据' },
      progressHistory: [
        { text: '读取市场数据' },
        { text: '正在整理四维度趋势数据' },
      ],
    });
  });

  it('bounds historical attempts and progress in the public execution timeline', () => {
    const subtasks = [
      makeSubtask({ id: 'sub_1', title: '生成报告', status: 'done' }),
    ];
    const dispatches = Array.from({ length: 25 }, (_, index) => ({
      attemptId: `attempt_${index}`,
      subtaskId: 'sub_1',
      status: 'terminal',
      attemptKind: index === 24 ? 'continuation' : 'primary',
      authorizedBinding: { agentClassRef: 'codex-cli' },
      createdAt: `2026-08-17T08:${String(index).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-08-17T08:${String(index).padStart(2, '0')}:30.000Z`,
    }));
    const history = Array.from({ length: 75 }, (_, index) => ({
      kind: 'status',
      text: index === 74
        ? 'Executor completed workspace command: cat /tmp/private.txt'
        : `步骤 ${index}`,
      occurredAt: `2026-08-17T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    const timeline = makeProjector({
      subtaskRepo: { listByTask: () => subtasks },
      dispatchItemRepo: { listByTask: () => dispatches },
      attemptRuntimeRepo: {
        find: () => ({
          progress: {
            kind: 'status',
            text: 'Executor started workspace command: cat /tmp/private.txt',
            history,
          },
        }),
      },
    }).project(makeTask({ status: 'done' }));

    const attempts = timeline.stages[2].subtasks?.[0]?.attempts ?? [];
    expect(attempts).toHaveLength(20);
    expect(attempts[0]?.attemptId).toBe('attempt_5');
    expect(attempts.at(-1)?.attemptId).toBe('attempt_24');
    expect(attempts.at(-1)).toMatchObject({
      attemptKind: 'continuation',
      attemptOrdinal: 20,
      attemptLabel: '继续执行',
      displayStatus: '已完成',
    });
    expect(attempts[0]?.progressHistory?.length).toBeLessThanOrEqual(50);
    expect(attempts[0]?.progressHistory?.[0]?.text).toBe('步骤 25');
    expect(attempts[0]?.progressHistory?.at(-1)?.text)
      .toBe('Executor completed a workspace command');
    expect(attempts[0]?.progress?.text).toBe('Executor started a workspace command');
    expect(JSON.stringify(attempts)).not.toContain('/tmp/private.txt');
  });

  it('verification 阶段按 receipt violations 推导 failed', () => {
    const subtasks = [makeSubtask({ id: 'sub_1', status: 'done' })];
    const receipts = [
      {
        subtaskId: 'sub_1',
        agentClassName: 'codex-cli',
        terminalState: 'contract_blocked',
        errorCode: null,
        errorDetail: null,
        verification: { warnings: [], violations: [{ key: 'x', description: 'bad' }] },
      },
    ];
    const timeline = makeProjector({
      subtaskRepo: { listByTask: () => subtasks },
      receiptRepo: { listByTask: () => receipts },
    }).project(makeTask());

    expect(timeline.stages[3].status).toBe('failed');
  });

  it('projects every attempt kind and terminal state as user-facing labels', () => {
    const kinds = [
      ['primary', '主执行'],
      ['continuation', '继续执行'],
      ['fallback', '回退执行'],
      ['contract_correction', '结果修正'],
      ['merge_repair', '合并修复'],
    ] as const;
    const dispatches = kinds.map(([attemptKind], index) => ({
      attemptId: `attempt_dispatch_event_exec_${index}_${attemptKind}`,
      subtaskId: 'sub_1',
      status: index === 0 ? 'cancelled' : 'terminal',
      attemptKind,
      authorizedBinding: { agentClassRef: 'codex-cli' },
      createdAt: `2026-08-17T08:00:0${index}.000Z`,
      updatedAt: `2026-08-17T08:00:1${index}.000Z`,
    }));
    const receipts = kinds.slice(1).map(([attemptKind], index) => ({
      attemptId: `attempt_dispatch_event_exec_${index + 1}_${attemptKind}`,
      subtaskId: 'sub_1',
      attemptKind,
      agentClassName: 'codex-cli',
      terminalState: index === 0 ? 'completed' : 'executor_failed',
      completedAt: `2026-08-17T08:00:2${index}.000Z`,
      errorCode: null,
      errorDetail: null,
      verification: { warnings: [], violations: [] },
    }));
    const timeline = makeProjector({
      subtaskRepo: {
        listByTask: () => [makeSubtask({ id: 'sub_1', status: 'done' })],
      },
      dispatchItemRepo: { listByTask: () => dispatches },
      receiptRepo: { listByTask: () => receipts },
    }).project(makeTask({ status: 'done' }));

    const attempts = timeline.stages[2].subtasks?.[0]?.attempts ?? [];
    expect(attempts.map(attempt => attempt.attemptLabel)).toEqual(kinds.map(([, label]) => label));
    expect(attempts.map(attempt => attempt.displayStatus)).toEqual([
      '已取消',
      '已完成',
      '失败',
      '失败',
      '失败',
    ]);
    expect(attempts[1]?.updatedAt).toBe('2026-08-17T08:00:20.000Z');
  });

  it('delivery 阶段 integrated 推导 done', () => {
    const subtasks = [makeSubtask({ id: 'sub_1', status: 'done' })];
    const timeline = makeProjector({
      subtaskRepo: { listByTask: () => subtasks },
      publicationRepo: {
        listIntegratedByTaskIds: () => [{ id: 'pub_1', taskId: 'task_1' }],
        hasBlockingResidue: () => false,
      },
    }).project(makeTask({ status: 'done' }));

    expect(timeline.stages[4].status).toBe('done');
  });
});
