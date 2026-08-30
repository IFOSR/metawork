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
