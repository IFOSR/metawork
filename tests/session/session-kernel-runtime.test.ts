import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { SessionKernelRuntime } from '../../src/session/session-kernel-runtime.js';
import { SessionPresentationService } from '../../src/session/session-presentation-service.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import type { KernelDecision } from '../../src/kernel/control-kernel.js';

describe('SessionKernelRuntime parallel admission', () => {
  it('persists a same-Conversation queued Task without preparing execution', async () => {
    const database = new Database(':memory:');
    runMigrations(database);
    const taskRepo = new TaskRepo(database);
    const taskRuntimeService = new TaskRuntimeService({
      taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-test-snapshots'),
      taskRepo,
    });
    taskRuntimeService.createTask({
      id: 'task-a',
      title: 'active task',
      goal: 'active task',
      accountId: 'account-a',
      conversationId: 'conversation-a',
      workspaceId: 'workspace-a',
      ownerPlannerSessionId: 'planner-a',
    });
    const scheduler = new ConversationTaskSchedulerRepo(database);
    scheduler.claimSlot('conversation-a', 'task-a', 'reservation-a', '2026-08-29T00:00:00.000Z');
    const prepared: string[] = [];
    const output: string[] = [];
    const plan = workGraphPlan({ goal: 'queued task', capabilityClass: 'code_edit' });
    plan.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = {
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision-queued',
      eventId: 'event-queued',
      reason: 'work graph authorized',
      action: {
        type: 'authorize_task_plan',
        taskId: 'task-b',
        task: plan.task,
        workGraph: plan.workGraph!,
        scheduleState: 'queued',
        owner: {
          conversationId: 'conversation-a',
          workspaceId: 'workspace-a',
          plannerSessionId: 'planner-a',
        },
        authorizedBindingsBySubtask: {},
        generationId: 'generation-b',
        graphRevision: 1,
        proposalSource: 'initial',
      },
    } as KernelDecision;
    const runtime = new SessionKernelRuntime({
      sessionId: 'planner-a',
      conversationId: 'conversation-a',
      taskRuntimeService,
      memoryContextService: {
        normalizeInlineResourcesFromInput: () => ({ normalizedGoal: 'queued task', resources: [] }),
      } as never,
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      conversationTaskSchedulerRepo: scheduler,
      accountId: 'account-a',
      callbacks: {
        appendOutput: (...lines: string[]) => output.push(...lines),
        prepareTaskExecution: taskId => prepared.push(taskId),
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async () => undefined,
      },
    });

    await runtime.forInput('queued task').apply(decision);

    expect(prepared).toEqual([]);
    expect(output).toContain('任务已加入当前会话队列；当前任务完成或释放后执行');
    expect(taskRuntimeService.findTask('task-b')).toMatchObject({
      accountId: 'account-a',
      conversationId: 'conversation-a',
      workspaceId: 'workspace-a',
      ownerPlannerSessionId: 'planner-a',
    });
    expect(scheduler.listQueuedTasks('conversation-a')).toEqual(['task-b']);
  });

  it('keeps clear_tasks scoped to the current Conversation', async () => {
    const database = new Database(':memory:');
    runMigrations(database);
    const taskRepo = new TaskRepo(database);
    const taskRuntimeService = new TaskRuntimeService({
      taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-test-snapshots'),
      taskRepo,
    });
    taskRuntimeService.createTask({
      id: 'task-a', title: 'conversation A', goal: 'conversation A',
      accountId: 'account-a', conversationId: 'conversation-a',
    });
    taskRuntimeService.createTask({
      id: 'task-b', title: 'conversation B', goal: 'conversation B',
      accountId: 'account-a', conversationId: 'conversation-b',
    });
    const cancelled: string[] = [];
    const runtime = new SessionKernelRuntime({
      sessionId: 'planner-a',
      conversationId: 'conversation-a',
      accountId: 'account-a',
      taskRuntimeService,
      memoryContextService: {
        normalizeInlineResourcesFromInput: () => ({ normalizedGoal: '', resources: [] }),
      } as never,
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      callbacks: {
        appendOutput: () => undefined,
        prepareTaskExecution: () => undefined,
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async taskId => { cancelled.push(taskId); },
      },
    });

    await runtime.forInput('clear this conversation').apply({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision-clear',
      eventId: 'event-clear',
      reason: 'task control authorized',
      action: {
        type: 'authorize_task_control',
        task: {
          binding: 'reference',
          taskId: null,
          control: 'clear_tasks',
          scope: 'all',
          title: null,
          goal: null,
          includeRecentConversationContext: false,
          priority: null,
        },
      },
    } as KernelDecision);

    expect(cancelled).toEqual(['task-a']);
  });

  it('preserves an account-capacity queue reason when slot admission loses the race', async () => {
    const database = new Database(':memory:');
    runMigrations(database);
    const taskRepo = new TaskRepo(database);
    const taskRuntimeService = new TaskRuntimeService({
      taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-test-snapshots'),
      taskRepo,
    });
    const scheduler = new ConversationTaskSchedulerRepo(database);
    const prepared: string[] = [];
    const plan = workGraphPlan({ goal: 'capacity queued task', capabilityClass: 'code_edit' });
    plan.workGraph!.subtasks[0]!.contextRefs = [];
    const runtime = new SessionKernelRuntime({
      sessionId: 'planner-b',
      accountId: 'account-a',
      taskRuntimeService,
      memoryContextService: {
        normalizeInlineResourcesFromInput: () => ({ normalizedGoal: 'capacity queued task', resources: [] }),
      } as never,
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      conversationTaskSchedulerRepo: scheduler,
      callbacks: {
        appendOutput: () => undefined,
        prepareTaskExecution: taskId => prepared.push(taskId),
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async () => undefined,
      },
    });
    const decision = {
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision-capacity-queued',
      eventId: 'event-capacity-queued',
      reason: 'account task capacity',
      action: {
        type: 'authorize_task_plan',
        taskId: 'task-capacity-queued',
        task: plan.task,
        workGraph: plan.workGraph!,
        scheduleState: 'queued',
        schedulingReason: 'account_task_capacity',
        owner: {
          conversationId: 'conversation-b',
          workspaceId: 'workspace-b',
          plannerSessionId: 'planner-b',
        },
        authorizedBindingsBySubtask: {},
        generationId: 'generation-capacity-queued',
        graphRevision: 1,
        proposalSource: 'initial',
      },
    } as KernelDecision;

    await runtime.forInput('capacity queued task').apply(decision);

    expect(prepared).toEqual([]);
    expect(database.prepare(
      'SELECT scheduling_reason FROM task_schedule_entries WHERE task_id = ?',
    ).get('task-capacity-queued')).toEqual({ scheduling_reason: 'account_task_capacity' });
  });
});

describe('SessionKernelRuntime abandon_task and durable clear outcomes (2026-09-06 plan)', () => {
  function setupRuntime(options: {
    outcomes?: Record<string, import('../../src/task/task-control-types.js').TaskClearOutcome>;
    cancelThrows?: string;
  } = {}) {
    const database = new Database(':memory:');
    runMigrations(database);
    const taskRepo = new TaskRepo(database);
    const taskRuntimeService = new TaskRuntimeService({
      taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-abandon-test'),
      taskRepo,
    });
    taskRuntimeService.createTask({
      id: 'task-old', title: 'old blocked task', goal: 'old',
      accountId: 'account-a', conversationId: 'conversation-a',
    });
    taskRuntimeService.createTask({
      id: 'task-foreign', title: 'other conversation task', goal: 'other',
      accountId: 'account-a', conversationId: 'conversation-b',
    });
    const output: string[] = [];
    const cancelCalls: Array<{ taskId: string; reason: string }> = [];
    const runtime = new SessionKernelRuntime({
      sessionId: 'planner-a',
      conversationId: 'conversation-a',
      accountId: 'account-a',
      taskRuntimeService,
      memoryContextService: {
        normalizeInlineResourcesFromInput: () => ({ normalizedGoal: '', resources: [] }),
      } as never,
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      callbacks: {
        appendOutput: (...lines: string[]) => output.push(...lines),
        prepareTaskExecution: () => undefined,
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async (taskId, reason) => {
          cancelCalls.push({ taskId, reason });
          if (options.cancelThrows) throw new Error(options.cancelThrows);
          return options.outcomes?.[taskId] ?? {
            taskId, status: 'cleared', residue: [],
          };
        },
      },
    });
    return { runtime, output, cancelCalls, taskRuntimeService };
  }

  const abandonDecision = (taskId: string) => ({
    schemaVersion: 5,
    configurationRevision: 'revision-test',
    id: `decision-abandon-${taskId}`,
    eventId: `event-abandon-${taskId}`,
    reason: 'explicit user decision',
    action: {
      type: 'authorize_task_control',
      task: {
        binding: 'reference',
        taskId,
        control: 'abandon_task',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
    },
  }) as KernelDecision;

  it('releases the old Task and tells the user to resubmit new work', async () => {
    const { runtime, output, cancelCalls } = setupRuntime();
    await runtime.forInput('放弃旧任务，开新的').apply(abandonDecision('task-old'));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.reason).toContain('abandon_task');
    expect(output.join('\n')).toContain('旧任务 #task-old 已取消并释放');
    expect(output.join('\n')).toContain('请重发你的新需求');
  });

  it('holds the new Task with a named phase when cancellation stays uncertain', async () => {
    const { runtime, output } = setupRuntime({
      outcomes: {
        'task-old': {
          taskId: 'task-old',
          status: 'clear_blocked',
          residue: [],
          phase: 'UNIQUE constraint failed during drain',
        },
      },
    });
    await runtime.forInput('放弃旧任务，开新的').apply(abandonDecision('task-old'));
    expect(output.join('\n')).toContain('新任务暂缓');
    expect(output.join('\n')).toContain('UNIQUE constraint failed during drain');
  });

  it('reports in-flight cleanup for recovery_in_progress outcomes', async () => {
    const { runtime, output } = setupRuntime({
      outcomes: {
        'task-old': {
          taskId: 'task-old',
          status: 'recovery_in_progress',
          residue: ['dispatch', 'publication'],
        },
      },
    });
    await runtime.forInput('放弃旧任务，开新的').apply(abandonDecision('task-old'));
    expect(output.join('\n')).toContain('后台清理中');
    expect(output.join('\n')).toContain('dispatch, publication');
  });

  it('never abandons a Task owned by another Conversation', async () => {
    const { runtime, output } = setupRuntime();
    await expect(
      runtime.forInput('放弃那个任务').apply(abandonDecision('task-foreign')),
    ).rejects.toThrow('another Conversation');
    expect(output.join('\n')).not.toContain('已取消并释放');
  });

  it('skips cancellation for an already-terminal old Task', async () => {
    const { runtime, output, cancelCalls, taskRuntimeService } = setupRuntime();
    taskRuntimeService.transitionTask('task-old', 'ready');
    taskRuntimeService.transitionTask('task-old', 'running');
    taskRuntimeService.cancelTask('task-old');
    await runtime.forInput('放弃旧任务').apply(abandonDecision('task-old'));
    expect(cancelCalls).toHaveLength(0);
    expect(output.join('\n')).toContain('已处于终态');
  });

  it('reports the durable outcome per Task for /task clear all', async () => {
    const { runtime, output } = setupRuntime({
      outcomes: {
        'task-old': { taskId: 'task-old', status: 'recovery_in_progress', residue: ['dispatch'] },
        'task-foreign': { taskId: 'task-foreign', status: 'cleared', residue: [] },
      },
    });
    await runtime.forInput('/task clear all').apply({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision-clear-outcome',
      eventId: 'event-clear-outcome',
      reason: 'task control authorized',
      action: {
        type: 'authorize_task_control',
        task: {
          binding: 'none',
          taskId: null,
          control: 'clear_tasks',
          scope: 'all',
          title: null,
          goal: null,
          includeRecentConversationContext: false,
          priority: null,
        },
      },
    } as KernelDecision);
    const text = output.join('\n');
    expect(text).toContain('#task-old [已受理，后台清理中（残留: dispatch）] old blocked task');
    expect(text).not.toContain('task-foreign');
  });
});

describe('SessionKernelRuntime abandon-and-create (2026-09-06 plan §5.4)', () => {
  function buildAbandonAndCreateRuntime(options: {
    cancelOutcome?: import('../../src/task/task-control-types.js').TaskClearOutcome;
  } = {}) {
    const database = new Database(':memory:');
    runMigrations(database);
    const taskRepo = new TaskRepo(database);
    const taskRuntimeService = new TaskRuntimeService({
      taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-abandon-create'),
      taskRepo,
    });
    taskRuntimeService.createTask({
      id: 'task-old', title: 'old task', goal: 'old',
      accountId: 'account-a', conversationId: 'conversation-a',
    });
    taskRuntimeService.createTask({
      id: 'task-foreign', title: 'foreign task', goal: 'foreign',
      accountId: 'account-a', conversationId: 'conversation-b',
    });
    const scheduler = new ConversationTaskSchedulerRepo(database);
    scheduler.claimSlot('conversation-a', 'task-old', 'reservation-old', '2026-08-29T00:00:00.000Z');
    const output: string[] = [];
    const cancelled: string[] = [];
    const prepared: string[] = [];
    const runtime = new SessionKernelRuntime({
      sessionId: 'planner-a',
      conversationId: 'conversation-a',
      accountId: 'account-a',
      taskRuntimeService,
      memoryContextService: {
        normalizeInlineResourcesFromInput: () => ({ normalizedGoal: 'new work', resources: [] }),
      } as never,
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      conversationTaskSchedulerRepo: scheduler,
      callbacks: {
        appendOutput: (...lines: string[]) => output.push(...lines),
        prepareTaskExecution: taskId => prepared.push(taskId),
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async taskId => {
          cancelled.push(taskId);
          return options.cancelOutcome ?? { taskId, status: 'cleared', residue: [] };
        },
      },
    });
    return { runtime, output, cancelled, prepared, scheduler, taskRuntimeService };
  }

  const conflictDecision = () => {
    const plan = workGraphPlan({ goal: 'new work', capabilityClass: 'code_edit' });
    plan.workGraph!.subtasks[0]!.contextRefs = [];
    return {
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision-conflict',
      eventId: 'event-conflict',
      reason: 'abandon-and-create authorized',
      action: {
        type: 'authorize_task_plan',
        taskId: 'task-new',
        task: plan.task,
        workGraph: plan.workGraph!,
        scheduleState: 'queued',
        owner: {
          conversationId: 'conversation-a',
          workspaceId: 'workspace-a',
          plannerSessionId: 'planner-a',
        },
        authorizedBindingsBySubtask: {},
        generationId: 'generation-new',
        graphRevision: 1,
        proposalSource: 'initial',
        conflictResolution: { oldTaskId: 'task-old' },
      },
    } as KernelDecision;
  };

  it('abandons the old Task first, then creates and queues the new Task', async () => {
    const { runtime, cancelled, prepared, scheduler, taskRuntimeService } = buildAbandonAndCreateRuntime();
    await runtime.forInput('放弃旧任务，开始新任务').apply(conflictDecision());
    expect(cancelled).toEqual(['task-old']);
    expect(taskRuntimeService.findTask('task-new')).toMatchObject({
      conversationId: 'conversation-a',
    });
    // The old slot is still held (cancellation cleanup pending); the new Task
    // waits in the queue and is promoted only after the slot releases.
    expect(scheduler.listQueuedTasks('conversation-a')).toEqual(['task-new']);
    expect(prepared).toEqual([]);
  });

  it('holds the new Task with a named phase when the old cancellation is blocked', async () => {
    const { runtime, output, taskRuntimeService } = buildAbandonAndCreateRuntime({
      cancelOutcome: {
        taskId: 'task-old',
        status: 'clear_blocked',
        residue: [],
        phase: 'UNIQUE constraint failed during drain',
      },
    });
    await runtime.forInput('放弃旧任务，开始新任务').apply(conflictDecision());
    expect(output.join('\n')).toContain('新任务暂缓');
    expect(output.join('\n')).toContain('UNIQUE constraint failed during drain');
    expect(taskRuntimeService.findTask('task-new')).toBeNull();
  });

  it('rejects abandoning an old Task owned by another Conversation', async () => {
    const { runtime, cancelled, taskRuntimeService } = buildAbandonAndCreateRuntime();
    const decision = conflictDecision();
    (decision.action as { conflictResolution: { oldTaskId: string } }).conflictResolution = {
      oldTaskId: 'task-foreign',
    };
    await expect(
      runtime.forInput('放弃那个任务').apply(decision),
    ).rejects.toThrow('another Conversation');
    expect(cancelled).toEqual([]);
    expect(taskRuntimeService.findTask('task-new')).toBeNull();
  });
});

describe('SessionKernelRuntime abandon-and-create holds during cleanup (closure round 3)', () => {
  it('never creates the new Task while the old cancellation is still cleaning up', async () => {
    const database = new Database(':memory:');
    runMigrations(database);
    const taskRepo = new TaskRepo(database);
    const taskRuntimeService = new TaskRuntimeService({
      taskEngine: new TaskEngine(taskRepo, '/tmp/metawork-abandon-hold'),
      taskRepo,
    });
    taskRuntimeService.createTask({
      id: 'task-old', title: 'old', goal: 'old',
      accountId: 'account-a', conversationId: 'conversation-a',
    });
    const scheduler = new ConversationTaskSchedulerRepo(database);
    scheduler.claimSlot('conversation-a', 'task-old', 'res', '2026-08-29T00:00:00.000Z');
    const output: string[] = [];
    const runtime = new SessionKernelRuntime({
      sessionId: 'planner-a',
      conversationId: 'conversation-a',
      accountId: 'account-a',
      taskRuntimeService,
      memoryContextService: {
        normalizeInlineResourcesFromInput: () => ({ normalizedGoal: 'new', resources: [] }),
      } as never,
      orchestration: {} as never,
      activeExecutions: {} as never,
      presentation: new SessionPresentationService(),
      conversationTaskSchedulerRepo: scheduler,
      callbacks: {
        appendOutput: (...lines: string[]) => output.push(...lines),
        prepareTaskExecution: () => undefined,
        refreshRuntimeState: () => undefined,
        setCurrentTaskId: () => undefined,
        getCurrentTaskId: () => null,
        setFocusContext: () => undefined,
        resolveRequestText: () => '',
        deliverDirectReply: () => undefined,
        cancelTask: async taskId => ({
          taskId,
          status: 'recovery_in_progress' as const,
          residue: ['dispatch'],
        }),
      },
    });
    const plan = workGraphPlan({ goal: 'new', capabilityClass: 'code_edit' });
    plan.workGraph!.subtasks[0]!.contextRefs = [];
    await runtime.forInput('放弃旧任务，开始新任务').apply({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision-hold',
      eventId: 'event-hold',
      reason: 'abandon-and-create authorized',
      action: {
        type: 'authorize_task_plan',
        taskId: 'task-new',
        task: plan.task,
        workGraph: plan.workGraph!,
        scheduleState: 'queued',
        owner: { conversationId: 'conversation-a', workspaceId: 'workspace-a', plannerSessionId: 'planner-a' },
        authorizedBindingsBySubtask: {},
        generationId: 'generation-new',
        graphRevision: 1,
        proposalSource: 'initial',
        conflictResolution: { oldTaskId: 'task-old' },
      },
    } as KernelDecision);

    expect(output.join('\n')).toContain('新任务暂缓');
    expect(output.join('\n')).toContain('后台清理中');
    expect(taskRuntimeService.findTask('task-new')).toBeNull();
    expect(scheduler.listQueuedTasks('conversation-a')).toEqual([]);
  });
});
