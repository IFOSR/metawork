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
    decisionRepo: { listByTask: () => [] },
    publicationRepo: { listIntegratedByTaskIds: () => [], hasBlockingResidue: () => false },
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
        listByTask: () => [
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
    }).project(makeTask());

    const execution = timeline.stages[2];
    expect(execution.status).toBe('running');
    const sub1 = execution.subtasks?.find(subtask => subtask.id === 'sub_1');
    expect(sub1?.executor).toBe('codex-cli');
    expect(sub1?.attempts[0]?.result).toBe('success');
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
