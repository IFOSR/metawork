import type { KernelDecision, KernelEvent } from '../kernel/control-kernel.js';
import type { KernelRuntime } from '../kernel/kernel-workflow.js';
import type { MemoryContextService } from '../memory/memory-context-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { ActiveExecutionControl } from '../execution/active-execution-control.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { SessionPresentationService } from './session-presentation-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { TaskClearOutcome, TaskClearScope, TaskStatusQueryScope } from '../task/task-control-types.js';
import type { Task } from '../core/types.js';
import type {
  ConversationTaskSchedulerRepo,
  QueuedTaskPayload,
} from '../storage/conversation-task-scheduler-repo.js';
import { taskBelongsToConversation } from '../task/task-ownership.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionKernelRuntimeDeps {
  sessionId: string;
  /** Immutable semantic owner used for Conversation-local task controls. */
  conversationId?: string;
  /** Only the retained MetaclawSession facade may read pre-owner legacy Tasks. */
  legacyCompatibility?: boolean;
  accountId?: string;
  taskRuntimeService: TaskRuntimeService;
  memoryContextService: MemoryContextService;
  orchestration: OrchestrationEngine;
  activeExecutions: ActiveExecutionControl;
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    onDecisionApplying?(decision: KernelDecision): void;
    deliverDirectReply(userInput: string, reply: string): void;
    prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): void;
    refreshRuntimeState(): void;
    setCurrentTaskId(taskId: string | null): void;
    getCurrentTaskId(): string | null;
    setFocusContext(focus: FocusContext | null): void;
    resolveRequestText(eventId: string): string;
    cancelTask(taskId: string, reason: string): Promise<TaskClearOutcome>;
  };
}

/** Session-side Runtime handlers for Kernel decisions; it contains no next-action policy. */
export class SessionKernelRuntime {
  constructor(private readonly deps: SessionKernelRuntimeDeps) {}

  forInput(userInput?: string, conversationId?: string): KernelRuntime {
    return {
      apply: decision => this.apply(
        decision,
        userInput ?? this.deps.callbacks.resolveRequestText(decision.eventId),
        conversationId,
      ),
    };
  }

  private async apply(
    decision: KernelDecision,
    userInput: string,
    conversationId = this.deps.conversationId ?? this.deps.sessionId,
  ): Promise<KernelEvent | null> {
    this.deps.callbacks.onDecisionApplying?.(decision);
    switch (decision.action.type) {
      case 'reject_request':
        this.deps.callbacks.appendOutput(this.deps.presentation.formatKernelRejection(decision.reason));
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'request_clarification':
        this.deps.callbacks.appendOutput(
          '## ❓ 需要你回答（任务在此等待，不会自动继续）',
          '',
          decision.action.question,
          '',
          '> 直接回复本条消息即可继续；若不再需要，可发送 `/task clear all` 取消相关任务。',
        );
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'deliver_direct_reply':
        this.deps.callbacks.deliverDirectReply(userInput, decision.action.response);
        return null;
      case 'no_op':
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'authorize_task_control':
        await this.applyTaskControl(decision, userInput, conversationId);
        return null;
      case 'resume_task': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (!task) return null;
        this.deps.callbacks.prepareTaskExecution(task.id, {
          userPrompt: task.goal,
          contextTaskId: task.id,
          executionMode: decision.action.blockerCategory === 'parked'
            ? 'resume-parked'
            : 'resume-blocked',
          origin: 'user',
          schedulingReason: `Kernel-authorized resume after ${decision.action.blockerCategory} blocker`,
        });
        return null;
      }
      case 'authorize_task_plan':
        await this.applyTaskPlan(decision, userInput);
        return null;
      case 'record_permission_resolution':
        return null;
      case 'block_work': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (task?.status === 'running') {
          this.deps.taskRuntimeService.blockTask(task.id, {
            taskId: task.id, type: 'manual', description: decision.reason, status: 'waiting',
          });
        }
        this.deps.callbacks.refreshRuntimeState();
        return null;
      }
      case 'park_for_replan': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (task && task.status !== 'parked') this.deps.taskRuntimeService.transitionTask(task.id, 'parked');
        return null;
      }
      case 'wait_for_capacity':
      case 'wait_for_retry':
      case 'probe_capacity':
      case 'dispatch_batch':
      case 'complete_task':
      case 'request_replan':
      case 'queue_generation_replan':
      case 'request_merge_replan':
      case 'cancel_task':
      case 'cancel_subtasks':
      case 'accept_partial_result':
      case 'resolve_recovery':
      case 'grant_capability':
      case 'deny_capability':
      case 'escalate_capability':
      case 'wait_for_partition':
      case 'recover_workspace_attempt':
      case 'defer_task_plan_for_availability':
      case 'activate_deferred_task_plan':
        throw new Error(`${decision.action.type} must be applied by the execution Runtime`);
    }
  }

  private async applyTaskControl(
    decision: Extract<KernelDecision, { action: { type: 'authorize_task_control' } }> | KernelDecision,
    userInput: string,
    conversationId: string,
  ): Promise<void> {
    if (decision.action.type !== 'authorize_task_control') return;
    const taskCommand = decision.action.task;
    if (taskCommand.control === 'status_query') {
      const scope = normalizeStatusScope(taskCommand.scope);
      const conversationTasks = this.deps.taskRuntimeService.listTasks()
        .filter(task => taskBelongsToConversation(
          task,
          conversationId,
          this.deps.legacyCompatibility,
        ));
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskStatus({
        scope,
        blockedTasks: this.deps.orchestration.getBlockedTasks()
          .filter(task => taskBelongsToConversation(
            task,
            conversationId,
            this.deps.legacyCompatibility,
          )),
        runningTask: conversationTasks.find(task => task.status === 'running') ?? null,
        activeTasks: conversationTasks.filter(task => (
          ['created', 'ready', 'running', 'parked', 'blocked'].includes(task.status)
        )),
        latestDone: conversationTasks.find(task => task.status === 'done') ?? null,
        dashboard: scopeDashboard(this.deps.orchestration.getDashboard(), conversationTasks),
      }));
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
    if (taskCommand.control === 'clear_tasks') {
      const scope = normalizeClearScope(taskCommand.scope);
      const statuses = scope === 'all'
        ? ['created', 'ready', 'running', 'parked', 'blocked']
        : [scope];
      const candidates = this.deps.taskRuntimeService.listTasks()
        .filter(task => statuses.includes(task.status) && (
          taskBelongsToConversation(task, conversationId, this.deps.legacyCompatibility)
        ));
      // §5.3.7: report the actual durable outcome per Task instead of a
      // blanket "cancelled N tasks" that hides uncertain state.
      const outcomes: Array<TaskClearOutcome & { title: string }> = [];
      for (const task of candidates) {
        try {
          const outcome = await this.deps.callbacks.cancelTask(
            task.id,
            `Planner-authorized clear_tasks (${scope})`,
          );
          outcomes.push({ ...outcome, title: task.title });
        } catch (error) {
          outcomes.push({
            taskId: task.id,
            status: 'clear_blocked',
            residue: [],
            phase: error instanceof Error ? error.message : String(error),
            title: task.title,
          });
        }
      }
      const result = { cancelled: candidates, runningCancelled: candidates.some(task => task.status === 'running') };
      if (result.cancelled.some(task => task.id === this.deps.callbacks.getCurrentTaskId())) {
        this.deps.callbacks.setCurrentTaskId(null);
        this.deps.callbacks.setFocusContext(null);
      }
      this.deps.callbacks.appendOutput(this.deps.presentation.formatTaskClearResult({
        scope,
        ...result,
        outcomes,
      }));
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
    if (taskCommand.control === 'abandon_task') {
      // §5.4 explicit abandon-and-create: applies only to the exact old Task
      // in the current Conversation; a new Task is never created before the
      // cancellation postconditions are durable; uncertain cancellations hold
      // the new Task with a named phase instead of pretending success.
      if (!taskCommand.taskId) throw new Error('abandon_task requires the exact old Task id');
      const task = this.deps.taskRuntimeService.findTask(taskCommand.taskId);
      if (!task) throw new Error(`task not found: ${taskCommand.taskId}`);
      if (!taskBelongsToConversation(task, conversationId, this.deps.legacyCompatibility)) {
        throw new Error('abandon_task target is owned by another Conversation');
      }
      if (['cancelled', 'done', 'failed', 'archived'].includes(task.status)) {
        this.deps.callbacks.appendOutput(
          `旧任务 #${task.id} 已处于终态（${task.status}），无需放弃；会话准入状态将在下次规划前自动核对。`,
        );
        this.deps.callbacks.refreshRuntimeState();
        return;
      }
      const outcome = await this.deps.callbacks.cancelTask(
        task.id,
        `Planner-authorized abandon_task (explicit user decision on ${task.id})`,
      );
      if (outcome.status === 'cleared' || outcome.status === 'already_cleared') {
        this.deps.callbacks.setCurrentTaskId(null);
        this.deps.callbacks.setFocusContext(null);
        this.deps.callbacks.appendOutput(
          `旧任务 #${task.id} 已取消并释放；请重发你的新需求，将作为新任务接纳。`,
        );
      } else if (outcome.status === 'recovery_in_progress') {
        this.deps.callbacks.appendOutput(
          `旧任务 #${task.id} 取消已受理，后台清理中（残留: ${outcome.residue.join(', ') || '无'}）；完成后即可提交新任务。`,
        );
      } else {
        this.deps.callbacks.appendOutput(
          `新任务暂缓：旧任务 #${task.id} 取消未完成（阶段: ${outcome.phase ?? '未知'}）。`,
        );
      }
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
    if (!taskCommand.taskId) throw new Error('authorized executable task control requires taskId');
    const task = this.deps.taskRuntimeService.findTask(taskCommand.taskId);
    if (!task) throw new Error(`task not found: ${taskCommand.taskId}`);
    this.deps.callbacks.setCurrentTaskId(task.id);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
    this.deps.callbacks.prepareTaskExecution(task.id, buildExecutionRequest({
      userInput,
      taskId: task.id,
      executionMode: task.status === 'blocked' ? 'resume-blocked' : 'resume-parked',
      decision,
      recoveryTrigger: task.status === 'blocked'
        ? {
            kind: /^\/task\s+/iu.test(userInput) ? 'explicit-task-command' : 'natural-language-resume',
            blockedReason: task.dependencies
              .filter(dependency => dependency.status === 'waiting')
              .map(dependency => dependency.description)
              .filter(Boolean)
              .join('；') || '未知原因',
            triggerReason: /^\/task\s+/iu.test(userInput) ? '显式解除阻塞' : '自然语言确认阻塞已解除',
            sourceInputExcerpt: userInput.replace(/\s+/g, ' ').trim().slice(0, 80),
          }
        : undefined,
    }));
  }

  private async applyTaskPlan(
    decision: Extract<KernelDecision, { action: { type: 'authorize_task_plan' } }> | KernelDecision,
    userInput: string,
  ): Promise<void> {
    if (decision.action.type !== 'authorize_task_plan') return;
    const command = decision.action.task;
    // §5.4 abandon-and-create: abandon the exact old Task FIRST, then admit
    // the new plan. The new Task is never created before the cancellation
    // authorization is durable; an uncertain cancellation holds the new Task
    // with a named phase instead of pretending to schedule it.
    if (decision.action.conflictResolution) {
      const oldTask = this.deps.taskRuntimeService.findTask(
        decision.action.conflictResolution.oldTaskId,
      );
      if (!oldTask) {
        throw new Error(`conflictResolution old Task not found: ${decision.action.conflictResolution.oldTaskId}`);
      }
      if (!taskBelongsToConversation(
        oldTask,
        decision.action.owner.conversationId,
        this.deps.legacyCompatibility,
      )) {
        throw new Error('conflictResolution old Task is owned by another Conversation');
      }
      const outcome = await this.deps.callbacks.cancelTask(
        oldTask.id,
        `abandon-and-create: abandon ${oldTask.id} before new Task ${decision.action.taskId}`,
      );
      if (outcome.status === 'clear_blocked') {
        this.deps.callbacks.appendOutput(
          `新任务暂缓：旧任务 #${oldTask.id} 取消未完成（阶段: ${outcome.phase ?? '未知'}）。`,
        );
        this.deps.callbacks.refreshRuntimeState();
        return;
      }
      if (outcome.status === 'recovery_in_progress') {
        // §4.2: the new Task is never created before the old Task is fully
        // released — an in-flight cleanup still holds the slot.
        this.deps.callbacks.appendOutput(
          `新任务暂缓：旧任务 #${oldTask.id} 已受理取消，后台清理中（残留: ${outcome.residue.join(', ') || '无'}）；清理完成后请重发需求。`,
        );
        this.deps.callbacks.refreshRuntimeState();
        return;
      }
    }
    const inline = this.deps.memoryContextService.normalizeInlineResourcesFromInput(userInput);
    const task = command.taskId
      ? this.deps.taskRuntimeService.findTask(command.taskId)
      : this.deps.taskRuntimeService.createTask({
          id: decision.action.taskId,
          title: (command.title ?? inline.normalizedGoal).slice(0, 50),
          goal: command.goal ?? inline.normalizedGoal,
          resources: inline.resources,
          accountId: this.deps.accountId,
          conversationId: decision.action.owner.conversationId,
          workspaceId: decision.action.owner.workspaceId ?? undefined,
          ownerPlannerSessionId: decision.action.owner.plannerSessionId,
        });
    if (!task) throw new Error(`task not found: ${command.taskId}`);
    if (command.priority) {
      this.deps.taskRuntimeService.updateTask(task.id, {
        prioritySignals: {
          ...task.prioritySignals,
          semanticPriority: command.priority.level,
          semanticPriorityReason: command.priority.reason,
        },
      });
    }
    if (!command.taskId && this.deps.conversationTaskSchedulerRepo) {
      const owner = decision.action.owner;
      const now = new Date().toISOString();
      const payload: QueuedTaskPayload = {
        requestText: userInput.slice(0, 24_000),
        generationId: decision.action.generationId,
        graphRevision: decision.action.graphRevision,
        workGraph: decision.action.workGraph,
        authorizedBindingsBySubtask: decision.action.authorizedBindingsBySubtask,
        workspaceId: owner.workspaceId,
        plannerSessionId: owner.plannerSessionId,
        kernelDecisionId: decision.id,
        proposalSource: decision.action.proposalSource,
        includeRecentConversationContext: command.includeRecentConversationContext,
        schedulingReason: decision.action.schedulingReason ?? decision.reason,
      };
      // Persist the authorized execution fact before attempting the slot claim.
      // A failed claim therefore leaves a recoverable queue entry rather than a
      // Task whose Planner proposal must be reconstructed later.
      this.deps.conversationTaskSchedulerRepo.enqueueTask(
        task.id,
        owner.conversationId,
        now,
        payload,
      );
      const slot = this.deps.conversationTaskSchedulerRepo.getSlot(owner.conversationId);
      const admitted = decision.action.scheduleState === 'eligible'
        && (slot.activeTaskId === task.id
          || this.deps.conversationTaskSchedulerRepo.claimSlot(
            owner.conversationId,
            task.id,
            decision.id,
            now,
          ));
      if (!admitted) {
        this.deps.conversationTaskSchedulerRepo.enqueueTask(
          task.id,
          owner.conversationId,
          now,
          payload.schedulingReason ?? 'conversation_slot_occupied',
          payload,
        );
        this.deps.callbacks.setCurrentTaskId(task.id);
        this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
        this.deps.callbacks.appendOutput(
          decision.action.schedulingReason === 'account_task_capacity'
            ? '任务已接纳，等待账户执行资源'
            : '任务已加入当前会话队列；当前任务完成或释放后执行',
        );
        this.deps.callbacks.refreshRuntimeState();
        return;
      }
      this.deps.conversationTaskSchedulerRepo.markRunning(task.id, now);
    }
    this.deps.callbacks.setCurrentTaskId(task.id);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: task.id });
    this.deps.callbacks.prepareTaskExecution(task.id, {
      ...buildExecutionRequest({ userInput, taskId: task.id, executionMode: 'fresh', decision }),
      authorizedWorkGraph: decision.action.workGraph,
      authorizedBindingsBySubtask: decision.action.authorizedBindingsBySubtask,
      workGraphAuthorization: {
        decisionId: decision.id,
        generationId: decision.action.generationId,
        revision: decision.action.graphRevision,
        source: decision.action.proposalSource,
        automaticReplan: decision.action.proposalSource === 'replan',
      },
      includeRecentConversationContext: command.includeRecentConversationContext,
    });
  }
}

function scopeDashboard(
  dashboard: ReturnType<OrchestrationEngine['getDashboard']>,
  tasks: Task[],
): ReturnType<OrchestrationEngine['getDashboard']> {
  const taskIds = new Set(tasks.map(task => task.id));
  const scopedBlocked = dashboard.blockedTasks.filter(task => taskIds.has(task.id));
  const scopedReady = dashboard.readyTasks.filter(task => taskIds.has(task.id));
  const scopedActive = tasks.filter(task => ['created', 'ready', 'running', 'parked'].includes(task.status));
  return {
    ...dashboard,
    summary: {
      ...dashboard.summary,
      active: scopedActive.length,
      blocked: scopedBlocked.length,
      parked: scopedActive.filter(task => task.status === 'parked').length,
      done: tasks.filter(task => task.status === 'done').length,
    },
    priorityTask: scopedReady[0] ? { ...scopedReady[0], reasons: [] } : null,
    blockedTasks: scopedBlocked,
    readyTasks: scopedReady,
  };
}

function buildExecutionRequest(input: {
  userInput: string;
  taskId: string;
  executionMode: QueuedExecutionRequest['executionMode'];
  decision: KernelDecision;
  recoveryTrigger?: QueuedExecutionRequest['recoveryTrigger'];
}): QueuedExecutionRequest {
  return {
    userPrompt: input.userInput,
    contextTaskId: input.taskId,
    executionMode: input.executionMode,
    kernelDecisionId: input.decision.id,
    schedulingReason: input.decision.reason,
    recoveryTrigger: input.recoveryTrigger,
  };
}

function normalizeStatusScope(scope: string | null): TaskStatusQueryScope {
  if (scope === 'blocked' || scope === 'running' || scope === 'dashboard') return scope;
  throw new Error(`Invalid status scope: ${String(scope)}`);
}

function normalizeClearScope(scope: string | null): TaskClearScope {
  if (scope === 'parked' || scope === 'blocked' || scope === 'all') return scope;
  throw new Error(`Invalid clear scope: ${String(scope)}`);
}
