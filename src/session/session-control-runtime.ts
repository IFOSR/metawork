import {
  capturePublicProjectBaseline,
  captureWorkspaceTargetBaseline,
} from '../delivery/public-project-baseline.js';
import type { ControlDecision, ControlEvent } from '../control/control-contracts.js';
import {
  ControlApplicationRejectionError,
  ControlApplicationSettledError,
  type ControlRuntime,
} from '../control/control-workflow.js';
import { normalizeInlineResourcesFromInput } from '../intent/inline-resource-normalization.js';
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
import type {
  TaskLifecyclePort,
} from '../task/task-lifecycle-transition-port.js';
import type { TaskStateAuthority } from '../task/task-state-authority.js';
import { PlanProposalUnavailableError, type PlanProposalStore } from '../execution/plan-proposal-store.js';
import type {
  PlanAdmissionResultInput,
  PlanAdmissionResultStore,
} from '../execution/plan-admission-result-store.js';
import type { PlanAdmissionApplicationService } from '../execution/plan-admission-application-service.js';
import type {
  PlanAdmissionRequest,
  PlanAdmissionResult,
} from '../execution/plan-admission-policy.js';
import type {
  PlanAdmissionAppliedResult,
  PlanAdmissionApplyContext,
} from '../execution/plan-admission-applier.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionControlRuntimeDeps {
  sessionId: string;
  /** Immutable semantic owner used for Conversation-local task controls. */
  conversationId?: string;
  /** Only the retained MetaclawSession facade may read pre-owner legacy Tasks. */
  legacyCompatibility?: boolean;
  accountId?: string;
  taskRuntimeService: TaskRuntimeService;
  taskStateAuthority: TaskStateAuthority;
  orchestration: OrchestrationEngine;
  activeExecutions: ActiveExecutionControl;
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo;
  planProposals?: PlanProposalStore;
  /** Durable applied-admission outcome; records what the Runtime concluded. */
  planAdmissionResults?: PlanAdmissionResultStore;
  /** Single writer of Task + origin + graph revision + admission result. */
  planAdmissionApplication: PlanAdmissionApplicationService;
  /** Durable availability deferral; the Job row and the Task block stay one owner. */
  deferPlanForAvailability?: (input: {
    proposal: PlanAdmissionRequest;
    taskId: string;
    explanation: string;
    bindings: Record<string, import('../core/authorized-executor-binding.js').AuthorizedExecutorBinding[]>;
  }) => boolean;
  presentation: SessionPresentationService;
  resolveUserWorkspaceRoot?: (conversationId: string) => Promise<string | null> | string | null;
  manageLocalService?: (taskId: string, operation: 'start' | 'stop' | 'restart', serviceId?: string, turnId?: string | null) => Promise<unknown>;
  callbacks: {
    appendOutput(...lines: string[]): void;
    onDecisionApplying?(decision: ControlDecision): void;
    prepareTaskExecution(taskId: string, request: QueuedExecutionRequest): void;
    refreshRuntimeState(): void;
    setCurrentTaskId(taskId: string | null): void;
    getCurrentTaskId(): string | null;
    setFocusContext(focus: FocusContext | null): void;
    resolveRequestText(eventId: string): string;
    cancelTask(taskId: string, reason: string): Promise<TaskClearOutcome>;
    /** Release the Conversation slot once this Task is safely waiting for input. */
    onWaitingForUser?(taskId: string): void;
  };
}

/** Session-side Runtime handlers for Kernel decisions; it contains no next-action policy. */
export class SessionControlRuntime {
  constructor(private readonly deps: SessionControlRuntimeDeps) {}

  forInput(userInput?: string, conversationId?: string, queryId?: string | null): ControlRuntime {
    return {
      apply: decision => this.apply(
        decision,
        userInput ?? this.deps.callbacks.resolveRequestText(decision.eventId),
        conversationId,
        queryId,
      ),
    };
  }

  /**
   * Applies a direct admission result. Producers evaluate the single admission
   * policy and hand the outcome here; nothing on this path reads or writes a
   * Kernel event, decision or application record.
   */
  async applyPlanAdmission(
    result: PlanAdmissionResult,
    context: PlanAdmissionApplyContext,
  ): Promise<PlanAdmissionAppliedResult> {
    const saved = this.deps.planProposals?.find(context.proposalId) ?? null;
    const operationId = saved?.operationId ?? `admission_${context.proposalId}`;
    const conversationId = context.conversationId ?? this.deps.conversationId ?? this.deps.sessionId;
    const applied = (
      status: PlanAdmissionAppliedResult['status'],
      taskId: string | null,
      schedulingReason: string | null = null,
      replayed = false,
    ): PlanAdmissionAppliedResult => ({
      operationId,
      status,
      taskId,
      reason: result.reason,
      schedulingReason,
      displayText: result.status === 'clarification' ? result.question : null,
      replayed,
    });
    // A proposal whose outcome is already durable is a replay: emitting the
    // same reply or question twice is a user-visible duplicate.
    const expectedStatus = result.status === 'authorized'
      ? (result.scheduleState === 'queued' ? 'queued' : 'authorized')
      : result.status;
    const recorded = saved ? this.deps.planAdmissionResults?.find(context.proposalId) ?? null : null;
    if (recorded && recorded.status === expectedStatus) {
      return {
        operationId,
        status: recorded.status,
        taskId: recorded.taskId,
        reason: recorded.reason,
        schedulingReason: recorded.detail?.schedulingReason ?? null,
        displayText: recorded.detail?.response ?? recorded.detail?.question ?? null,
        replayed: true,
      };
    }
    const record = (extra: Omit<PlanAdmissionResultInput, 'proposalId' | 'operationId' | 'appliedAt' | 'reason'>): void => {
      if (!saved) return;
      this.deps.planAdmissionResults?.record({
        ...extra,
        proposalId: context.proposalId,
        operationId,
        reason: result.reason,
        appliedAt: new Date().toISOString(),
      });
    };
    switch (result.status) {
      case 'rejected':
        record({ status: 'rejected' });
        this.deps.callbacks.appendOutput(this.deps.presentation.formatControlRejection(result.reason));
        this.deps.callbacks.refreshRuntimeState();
        return applied('rejected', null);
      case 'clarification': {
        record({ status: 'clarification', detail: { question: result.question } });
        this.deps.callbacks.appendOutput(
          '## ❓ 需要你回答（任务在此等待，不会自动继续）',
          '',
          result.question,
          '',
          '> 直接回复本条消息即可继续；若不再需要，可发送 `/task clear all` 取消相关任务。',
        );
        const taskId = this.deps.callbacks.getCurrentTaskId();
        if (taskId) this.markTaskWaitingForInput(taskId, result.question, operationId);
        this.deps.callbacks.refreshRuntimeState();
        return applied('clarification', null);
      }
      case 'no_action':
        record({ status: 'no_action' });
        this.deps.callbacks.refreshRuntimeState();
        return applied('no_action', null);
      case 'permission_resolution':
        // The exact resolution still goes through the permission service; this
        // path only records that the Planner interpretation was accepted.
        return applied('permission_resolution', result.taskId);
      case 'task_control':
        await this.applyTaskControlPayload(
          result.task,
          operationId,
          result.reason,
          context.userInput,
          conversationId,
          context.queryId ?? null,
        );
        return applied('task_control', result.task.taskId);
      case 'deferred': {
        const deferred = this.deps.deferPlanForAvailability?.({
          proposal: result.proposal,
          taskId: result.taskId,
          explanation: result.explanation,
          bindings: result.authorizedBindingsBySubtask,
        }) ?? false;
        if (!deferred) {
          // The Job moved on without this deferral; the Task block is not
          // authorized by this outcome.
          return applied('deferred', result.taskId);
        }
        this.blockTaskForAvailability(result.taskId, result.explanation, operationId);
        if (saved) {
          this.deps.planAdmissionResults?.record({
            proposalId: context.proposalId,
            operationId,
            status: 'deferred',
            reason: result.reason,
            taskId: result.taskId,
            generationId: result.proposal.generationId,
            graphRevision: result.proposal.targetGraphRevision,
            detail: { explanation: result.explanation },
            appliedAt: new Date().toISOString(),
          });
        }
        return applied('deferred', result.taskId);
      }
      case 'authorized':
        return this.applyAuthorizedPlan(result, context, operationId, conversationId);
    }
  }

  private blockTaskForAvailability(taskId: string, explanation: string, operationId: string): void {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return;
    this.deps.taskStateAuthority.reconcile({
      taskId,
      decisionId: operationId,
      operationKey: `availability:${operationId}`,
      actor: 'session-kernel-runtime',
      reason: explanation,
      facts: () => {
        this.deps.taskRuntimeService.updateTask(taskId, {
          dependencies: [
            ...task.dependencies.filter(dependency => !(
              dependency.status === 'waiting'
              && dependency.type === 'manual'
              && dependency.description === explanation
            )),
            {
              taskId,
              type: 'manual',
              description: explanation,
              status: 'waiting' as const,
              createdAt: new Date().toISOString(),
            },
          ],
        });
        return [];
      },
    });
    this.deps.callbacks.refreshRuntimeState();
  }

  private async apply(
    decision: ControlDecision,
    userInput: string,
    conversationId = this.deps.conversationId ?? this.deps.sessionId,
    queryId: string | null | undefined = null,
  ): Promise<ControlEvent | null> {
    const proposalOpen = this.assertProposalOpen(
      decision.eventId,
      decision.action.type === 'authorize_task_plan'
        || decision.action.type === 'request_clarification',
    );
    // An already-recorded conclusion that matches this Decision is a replay:
    // re-emitting it would duplicate user-visible output for one proposal. A
    // *different* conclusion falls through and is refused by the result store.
    if (proposalOpen && this.isReplayedAdmissionConclusion(decision)) return null;
    this.deps.callbacks.onDecisionApplying?.(decision);
    switch (decision.action.type) {
      case 'reject_request':
        if (proposalOpen) {
          this.recordAdmissionResult(decision.eventId, {
            status: 'rejected',
            reason: decision.reason,
          });
        }
        this.deps.callbacks.appendOutput(this.deps.presentation.formatControlRejection(decision.reason));
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'request_clarification': {
        const question = decision.action.question;
        if (proposalOpen) {
          this.recordAdmissionResult(decision.eventId, {
            status: 'clarification',
            reason: decision.reason,
            detail: { question },
          });
        }
        this.deps.callbacks.appendOutput(
          '## ❓ 需要你回答（任务在此等待，不会自动继续）',
          '',
          question,
          '',
          '> 直接回复本条消息即可继续；若不再需要，可发送 `/task clear all` 取消相关任务。',
        );
        // The Planner stopped this turn to ask the user. If a Task owns the
        // turn, it must say so durably and must not keep the Conversation slot:
        // otherwise the user's answer queues behind a Task that is only waiting
        // for them (design §1: 等待用户必须说清要用户做什么 / 待处理让出名额).
        const clarificationTaskId = this.deps.callbacks.getCurrentTaskId();
        if (clarificationTaskId) {
          this.markTaskWaitingForInput(clarificationTaskId, question, decision.id);
        }
        this.deps.callbacks.refreshRuntimeState();
        return null;
      }
      case 'no_op':
        if (proposalOpen) {
          this.recordAdmissionResult(decision.eventId, {
            status: 'no_action',
            reason: decision.reason,
          });
        }
        this.deps.callbacks.refreshRuntimeState();
        return null;
      case 'authorize_task_control':
        await this.applyTaskControlPayload(
          decision.action.task,
          decision.id,
          decision.reason,
          userInput,
          conversationId,
          queryId,
        );
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
          queryId,
          schedulingReason: `Control-authorized resume after ${decision.action.blockerCategory} blocker`,
        });
        return null;
      }
      case 'authorize_task_plan':
        // The ledger remains only for replan effects a D5 decision still
        // produces. It applies through the same owner applier as direct
        // admission, so there is no second application implementation.
        await this.applyAuthorizedPlan(
          planAdmissionFromControlDecision(decision),
          {
            proposalId: decision.eventId,
            userInput,
            ...(conversationId ? { conversationId } : {}),
            queryId: queryId ?? null,
          },
          decision.id,
          conversationId ?? this.deps.conversationId ?? this.deps.sessionId,
        );
        return null;
      case 'record_permission_resolution':
        return null;
      case 'block_work': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (task && task.status !== 'succeeded' && task.status !== 'failed'
          && task.status !== 'cancelled') {
          this.deps.taskStateAuthority.reconcile({
            taskId: task.id,
            decisionId: decision.id,
            operationKey: `block:${decision.id}`,
            actor: 'session-kernel-runtime',
            reason: decision.reason,
            facts: () => {
              this.deps.taskRuntimeService.updateTask(task.id, {
                dependencies: [
                  ...task.dependencies.filter(dependency => !(dependency.status === 'waiting'
                    && dependency.type === 'manual' && dependency.description === decision.reason)),
                  {
                    taskId: task.id,
                    type: 'manual',
                    description: decision.reason,
                    status: 'waiting' as const,
                    createdAt: new Date().toISOString(),
                  },
                ],
              });
              return [];
            },
          });
        }
        this.deps.callbacks.refreshRuntimeState();
        return null;
      }
      case 'await_user_decision':
        throw new Error('await_user_decision must be applied by the execution Runtime');
      case 'park_for_replan': {
        const task = this.deps.taskRuntimeService.findTask(decision.action.taskId);
        if (task && task.status !== 'needs_action' && task.status !== 'running') {
          this.deps.taskStateAuthority.reconcile({
            taskId: task.id,
            decisionId: decision.id,
            operationKey: `replan_park:${decision.id}`,
            actor: 'session-kernel-runtime',
            reason: decision.reason,
          });
        }
        return null;
      }
      case 'wait_for_capacity':
      case 'wait_for_retry':
      case 'supersede_retry_wake':
      case 'recover_retry_wake':
      case 'probe_capacity':
      case 'dispatch_batch':
      case 'complete_task':
      case 'request_replan':
      case 'schedule_replan':
      case 'queue_generation_replan':
      case 'request_merge_replan':
      case 'retry_remaining_work':
      case 'control_managed_service':
      case 'resolve_recovery':
      case 'grant_capability':
      case 'deny_capability':
      case 'escalate_capability':
      case 'wait_for_partition':
      case 'recover_workspace_attempt':
      case 'defer_task_plan_for_availability':
        throw new Error(`${decision.action.type} must be applied by the execution Runtime`);
    }
  }

  private isReplayedAdmissionConclusion(decision: ControlDecision): boolean {
    const store = this.deps.planAdmissionResults;
    if (!store) return false;
    const recorded = store.find(decision.eventId);
    if (!recorded) return false;
    const conclusion = decision.action.type === 'reject_request'
      ? 'rejected'
      : decision.action.type === 'request_clarification'
        ? 'clarification'
        : null;
    return conclusion !== null && recorded.status === conclusion;
  }

  /**
   * Records the applied admission outcome under `admission_<planId>`. The
   * proposal store keeps Manager output; this fact says what the Runtime
   * concluded, so delivery receipts and applied results cannot be confused.
   */
  private recordAdmissionResult(
    proposalId: string,
    input: Omit<PlanAdmissionResultInput, 'proposalId' | 'operationId' | 'appliedAt'>,
  ): void {
    const store = this.deps.planAdmissionResults;
    // The proposal store owns the operation identity; a second derivation here
    // would let the graph revision and this result disagree.
    const operationId = this.deps.planProposals?.find(proposalId)?.operationId;
    if (!store || !operationId) return;
    store.record({
      ...input,
      operationId,
      proposalId,
      appliedAt: new Date().toISOString(),
    });
  }

  private assertProposalOpen(eventId: string, required = false, priorEffects = false): boolean {
    const proposals = this.deps.planProposals;
    if (!proposals || (!required && !proposals.find(eventId))) return false;
    try {
      proposals.assertAdmissionOpen(eventId);
    } catch (error) {
      if (!(error instanceof PlanProposalUnavailableError)) throw error;
      if (priorEffects) throw new ControlApplicationSettledError(error.message, error.code);
      throw new ControlApplicationRejectionError(error.message, error.code);
    }
    return true;
  }

  /**
   * Records a durable "waiting for the user's answer" conclusion on the Task that
   * owns this turn. It is a real state change (needs_action + a `provide_input`
   * pending action), so every surface shows the same reason and the next answer
   * is a plain re-entry instead of a hidden blocker.
   */
  private markTaskWaitingForInput(taskId: string, question: string, decisionId: string): void {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task || task.status === 'succeeded' || task.status === 'failed'
      || task.status === 'cancelled') return;
    const boundedQuestion = question.replace(/[\r\n]+/gu, ' ').trim().slice(0, 320);
    const reason = {
      code: 'input_required' as const,
      message: boundedQuestion,
      evidenceRefs: [`decision:${decisionId}`],
    };
    try {
      this.deps.taskRuntimeService.applyTaskChange({
        taskId,
        decisionId,
        operationKey: `clarification:${decisionId}`,
        expectedVersion: task.stateVersion,
        generationId: null,
        graphRevision: null,
        to: task.status === 'running' ? 'needs_action' : task.status,
        detail: {
          reason,
          unresolved: [],
          phase: null,
          pendingActions: [{
            actionId: `input:${taskId}:${decisionId}`,
            kind: 'provide_input',
            label: '回复这条消息即可继续',
            reason,
            result: null,
          }],
          requiredWork: task.stateDetail.requiredWork,
          cleanup: task.stateDetail.cleanup,
          nextWakeAt: null,
        },
        actor: 'session-kernel-runtime',
        reason: 'Planner asked the user a clarifying question',
      });
      this.deps.callbacks.onWaitingForUser?.(taskId);
    } catch {
      // A concurrent state change supersedes this detail write; the answer path
      // reconciles the Task again from its own facts.
    }
  }

  private async applyTaskControlPayload(
    taskCommand: PlanAdmissionRequest['proposal']['task'],
    operationId: string,
    reason: string,
    userInput: string,
    conversationId: string,
    queryId?: string | null,
  ): Promise<void> {
    if (taskCommand.control.startsWith('service_')) {
      if (!taskCommand.taskId || !this.deps.manageLocalService) {
        const error = new ControlApplicationRejectionError('受管服务操作不可用', 'service_runtime_unavailable');
        this.deps.callbacks.appendOutput(error.message);
        this.deps.callbacks.refreshRuntimeState();
        throw error;
      }
      const task = this.deps.taskRuntimeService.findTask(taskCommand.taskId);
      if (!task || !taskBelongsToConversation(task, conversationId, this.deps.legacyCompatibility)) {
        // The refusal happens before any Runtime effect: converging is safe.
        // Surface it here because this branch runs before the service-operation
        // try/catch below.
        const error = new ControlApplicationRejectionError(
          `服务任务不属于当前会话：serviceId=${taskCommand.scope ?? '未指定'} `
          + `taskId=${taskCommand.taskId} conversationId=${conversationId}`,
          'service_not_in_conversation',
        );
        this.deps.callbacks.appendOutput(error.message);
        this.deps.callbacks.refreshRuntimeState();
        throw error;
      }
      const operation = taskCommand.control.slice('service_'.length) as 'start' | 'stop' | 'restart';
      try {
        const result = await this.deps.manageLocalService(task.id, operation, taskCommand.scope ?? undefined, queryId);
        this.deps.callbacks.appendOutput(JSON.stringify(result));
      } catch (error) {
        // The Kernel refuses with the real reason; a settled operation reports
        // the recorded failure. Both are converged, so neither may vanish.
        if (error instanceof ControlApplicationRejectionError
          || error instanceof ControlApplicationSettledError) {
          this.deps.callbacks.appendOutput(error.message);
        }
        throw error;
      } finally {
        this.deps.callbacks.refreshRuntimeState();
      }
      return;
    }
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
        needsActionTasks: this.deps.orchestration.getBlockedTasks()
          .filter(task => taskBelongsToConversation(
            task,
            conversationId,
            this.deps.legacyCompatibility,
          )),
        runningTask: conversationTasks.find(task => task.status === 'running') ?? null,
        activeTasks: conversationTasks.filter(task => (
          task.status === 'queued' || task.status === 'running' || task.status === 'needs_action'
        )),
        latestDone: conversationTasks.find(task => task.status === 'succeeded') ?? null,
        dashboard: scopeDashboard(this.deps.orchestration.getDashboard(), conversationTasks),
      }));
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
    if (taskCommand.control === 'clear_tasks') {
      const scope = normalizeClearScope(taskCommand.scope);
      // Both legacy scope names select the one pending state.
      const statuses = scope === 'all'
        ? ['queued', 'running', 'needs_action']
        : ['needs_action'];
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
    this.deps.callbacks.prepareTaskExecution(task.id, {
      userPrompt: userInput,
      contextTaskId: task.id,
      executionMode: task.status === 'needs_action' ? 'resume-blocked' : 'resume-parked',
      kernelDecisionId: operationId,
      schedulingReason: reason,
      queryId,
      recoveryTrigger: task.status === 'needs_action'
        ? {
            kind: /^\/task\s+/iu.test(userInput) ? 'explicit-task-command' : 'natural-language-resume',
            blockedReason: task.dependencies
              .filter(dependency => dependency.status === 'waiting')
              .map(dependency => dependency.description)
              .filter(Boolean)
              .join('；') || '未知原因',
            triggerReason: /^\/task\s+/iu.test(userInput) ? '显式继续处理' : '自然语言确认可以继续',
            sourceInputExcerpt: userInput.replace(/\s+/g, ' ').trim().slice(0, 80),
          }
        : undefined,
    });
  }

  private async applyAuthorizedPlan(
    result: Extract<PlanAdmissionResult, { status: 'authorized' }>,
    context: PlanAdmissionApplyContext,
    operationId: string,
    conversationId: string,
  ): Promise<PlanAdmissionAppliedResult> {
    const savedProposal = this.assertProposalOpen(context.proposalId);
    let abandonmentApplied = false;
    const command = result.task;
    // A persisted automatic replan from the pre-admission protocol carries no
    // immutable owner facts. Replaying it must still stay bound to the Task's
    // own Conversation and Workspace instead of dereferencing a missing field.
    const persistedOwner = result.owner
      ?? (() => {
        const existing = command.taskId
          ? this.deps.taskRuntimeService.findTask(command.taskId)
          : undefined;
        if (!existing) return undefined;
        return {
          conversationId: conversationId ?? existing.conversationId ?? this.deps.sessionId,
          workspaceId: existing.workspaceId ?? null,
          plannerSessionId: existing.ownerPlannerSessionId ?? this.deps.sessionId,
        };
      })();
    // §5.4 abandon-and-create: abandon the exact old Task FIRST, then admit
    // the new plan. The new Task is never created before the cancellation
    // authorization is durable; an uncertain cancellation holds the new Task
    // with a named phase instead of pretending to schedule it.
    if (result.conflictResolution) {
      const oldTask = this.deps.taskRuntimeService.findTask(
        result.conflictResolution.oldTaskId,
      );
      if (!oldTask) {
        throw new Error(`conflictResolution old Task not found: ${result.conflictResolution.oldTaskId}`);
      }
      if (!persistedOwner) throw new Error('legacy control operation has no Conversation owner');
      if (!taskBelongsToConversation(
        oldTask,
        persistedOwner.conversationId,
        this.deps.legacyCompatibility,
      )) {
        throw new Error('conflictResolution old Task is owned by another Conversation');
      }
      const outcome = await this.deps.callbacks.cancelTask(
        oldTask.id,
        `abandon-and-create: abandon ${oldTask.id} before new Task ${result.taskId}`,
      );
      if (outcome.status === 'clear_blocked') {
        this.deps.callbacks.appendOutput(
          `新任务暂缓：旧任务 #${oldTask.id} 取消未完成（阶段: ${outcome.phase ?? '未知'}）。`,
        );
        this.deps.callbacks.refreshRuntimeState();
        return {
          operationId, status: 'rejected', taskId: null, reason: `旧任务 #${oldTask.id} 取消未完成`,
          schedulingReason: null, displayText: null, replayed: false,
        };
      }
      if (outcome.status === 'recovery_in_progress') {
        // §4.2: the new Task is never created before the old Task is fully
        // released — an in-flight cleanup still holds the slot.
        this.deps.callbacks.appendOutput(
          `新任务暂缓：旧任务 #${oldTask.id} 已受理取消，后台清理中（残留: ${outcome.residue.join(', ') || '无'}）；清理完成后请重发需求。`,
        );
        this.deps.callbacks.refreshRuntimeState();
        return {
          operationId, status: 'rejected', taskId: null,
          reason: `旧任务 #${oldTask.id} 取消清理中`, schedulingReason: null, displayText: null,
          replayed: false,
        };
      }
      abandonmentApplied = true;
    }
    const inline = normalizeInlineResourcesFromInput(context.userInput);
    // The resolver is account-runtime scoped by Conversation id. `sessionId`
    // is the Planner/runtime process identity and may be different from the
    // Conversation that owns this plan.
    const ownerConversationId = conversationId ?? persistedOwner?.conversationId;
    // Retain delivery intent from the proposal. Execution is always bound to
    // the owning Conversation by the execution runtime; the historical mode
    // field must not label a new Task as an in-place execution.
    let workspaceExecution = result.workspaceExecution;
    // Persisted automatic replans from the pre-admission protocol do not carry
    // the newer decision payload. Reuse the owning Task's already-authorized
    // Workspace facts to finish that replan; the Runtime still creates and
    // validates the immutable Conversation Git binding before any Attempt.
    if (!workspaceExecution && command.taskId) {
      const existing = this.deps.taskRuntimeService.findTask(command.taskId);
      if (existing?.workspaceId) {
        workspaceExecution = {
          executionMode: 'conversation_git', source: 'planner', reason: 'recover persisted replan admission',
          deliveryPolicy: 'none',
          targetPaths: existing.workspaceTargetPaths ?? [],
        };
      }
    }
    if (!workspaceExecution) throw new Error('legacy control operation has no Workspace admission and cannot be dispatched');
    const admittedWorkspaceId = persistedOwner?.workspaceId
      ?? (result.workspaceAdmission?.kind === 'write' || result.workspaceAdmission?.kind === 'read'
        ? result.workspaceAdmission.workspaceId
        : null);
    if (!ownerConversationId) throw new Error('legacy control operation has no Conversation owner');
    const workspaceRoot = await this.deps.resolveUserWorkspaceRoot?.(ownerConversationId) ?? null;
    const publicWorkspace = command.publicProjectDirectory ? workspaceRoot : null;
    if (command.publicProjectDirectory && !publicWorkspace) throw new Error('无法确认现有项目的 Workspace');
    // Retained only for the legacy public-project delivery projection.
    const publicBaseline = command.publicProjectDirectory && publicWorkspace
      ? await capturePublicProjectBaseline(publicWorkspace, command.publicProjectDirectory)
      : {};
    // Admission is one durable transaction: Task, initial proposal origin,
    // authorized graph revision and applied outcome commit together. The
    // transaction re-reads the proposal lifecycle fence, so a Turn cancelled or
    // a Conversation deleted after the Workspace IO above cannot land a Task.
    let applied;
    try {
      applied = this.deps.planAdmissionApplication.apply({
        taskId: result.taskId,
        existingTaskId: command.taskId ?? null,
        owner: {
          conversationId: ownerConversationId,
          workspaceId: admittedWorkspaceId ?? null,
          plannerSessionId: persistedOwner?.plannerSessionId ?? this.deps.sessionId,
        },
        workspaceExecution,
        workspaceIntent: result.workspaceIntent ?? null,
        proposalSource: result.proposalSource,
        generationId: result.generationId,
        graphRevision: result.graphRevision,
        scheduleState: result.scheduleState,
        schedulingReason: result.schedulingReason ?? null,
        workGraph: result.workGraph,
        authorizedBindingsBySubtask: result.authorizedBindingsBySubtask,
        operationId: operationId,
        proposalId: savedProposal ? context.proposalId : null,
        requestText: context.userInput,
        queryId: context.queryId ?? null,
        includeRecentConversationContext: command.includeRecentConversationContext,
        task: {
          title: (command.title ?? inline.normalizedGoal).slice(0, 50),
          goal: command.goal ?? inline.normalizedGoal,
          resources: inline.resources,
          ...(command.publicProjectDirectory
            ? { publicTaskDirectory: command.publicProjectDirectory }
            : {}),
          publicDeliveryBaseline: publicBaseline,
          startServiceAfterPublish: command.startServiceAfterPublish ?? false,
          ...(this.deps.accountId ? { accountId: this.deps.accountId } : {}),
        },
        ...(command.priority
          ? { priority: { level: command.priority.level, reason: command.priority.reason } }
          : {}),
      });
    } catch (error) {
      if (error instanceof PlanProposalUnavailableError) {
        throw abandonmentApplied
          ? new ControlApplicationSettledError(error.message, error.code)
          : new ControlApplicationRejectionError(error.message, error.code);
      }
      throw error;
    }
    this.deps.callbacks.setCurrentTaskId(applied.taskId);
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: applied.taskId });
    if (applied.replayed) {
      // The durable outcome already exists; starting a second execution round
      // would duplicate Work for one proposal.
      this.deps.callbacks.refreshRuntimeState();
      return {
        operationId, status: applied.status, taskId: applied.taskId,
        reason: result.reason, schedulingReason: applied.schedulingReason,
        displayText: null, replayed: true,
      };
    }
    if (applied.status === 'queued') {
      this.deps.callbacks.appendOutput(
        result.schedulingReason === 'account_task_capacity'
          ? '任务已接纳，等待账户执行资源'
          : '任务已加入当前会话队列；当前任务完成或释放后执行',
      );
      this.deps.callbacks.refreshRuntimeState();
      return {
        operationId, status: 'queued', taskId: applied.taskId,
        reason: result.reason, schedulingReason: applied.schedulingReason,
        displayText: null, replayed: false,
      };
    }
    // The graph revision is already durable, so execution recovers it instead
    // of applying a second one for the same generation.
    this.deps.callbacks.prepareTaskExecution(applied.taskId, {
      userPrompt: context.userInput,
      contextTaskId: applied.taskId,
      executionMode: 'fresh',
      kernelDecisionId: operationId,
      schedulingReason: result.reason,
      queryId: context.queryId ?? null,
      authorizedWorkGraph: result.workGraph,
      authorizedBindingsBySubtask: result.authorizedBindingsBySubtask,
      workGraphAuthorization: {
        operationId: operationId,
        generationId: result.generationId,
        revision: result.graphRevision,
        source: result.proposalSource,
        automaticReplan: result.proposalSource === 'replan',
      },
      includeRecentConversationContext: command.includeRecentConversationContext,
    });
    return {
      operationId,
      status: 'authorized',
      taskId: applied.taskId,
      reason: result.reason,
      schedulingReason: applied.schedulingReason,
      displayText: null,
      replayed: false,
    };
  }
}

/**
 * Projects a Kernel plan decision onto the owner result shape. Used only by the
 * remaining replan effect path; it adds no policy and no second applier.
 */
function planAdmissionFromControlDecision(
  decision: ControlDecision,
): Extract<PlanAdmissionResult, { status: 'authorized' }> {
  if (decision.action.type !== 'authorize_task_plan') {
    throw new Error(`expected authorize_task_plan, received ${decision.action.type}`);
  }
  const action = decision.action;
  return {
    status: 'authorized',
    reason: decision.reason,
    taskId: action.taskId,
    task: action.task,
    workGraph: action.workGraph,
    scheduleState: action.scheduleState,
    ...(action.schedulingReason ? { schedulingReason: action.schedulingReason } : {}),
    owner: action.owner,
    authorizedBindingsBySubtask: action.authorizedBindingsBySubtask,
    generationId: action.generationId,
    graphRevision: action.graphRevision,
    proposalSource: action.proposalSource,
    routing: {},
    workspaceExecution: action.workspaceExecution,
    // Pre-admission replans persisted without a Workspace fact recover the
    // existing Task's admitted Workspace in the applier.
    workspaceAdmission: action.workspaceAdmission ?? { kind: 'read', workspaceId: null, targetPaths: [] },
    workspaceIntent: action.workspaceIntent ?? null,
    ...(action.conflictResolution ? { conflictResolution: action.conflictResolution } : {}),
  };
}

function scopeDashboard(
  dashboard: ReturnType<OrchestrationEngine['getDashboard']>,
  tasks: Task[],
): ReturnType<OrchestrationEngine['getDashboard']> {
  const taskIds = new Set(tasks.map(task => task.id));
  const scopedBlocked = dashboard.blockedTasks.filter(task => taskIds.has(task.id));
  const scopedReady = dashboard.readyTasks.filter(task => taskIds.has(task.id));
  const scopedActive = tasks.filter(task => (
    task.status === 'running' || task.status === 'needs_action'
  ));
  return {
    ...dashboard,
    summary: {
      ...dashboard.summary,
      active: scopedActive.length,
      blocked: scopedBlocked.length,
      parked: 0,
      done: tasks.filter(task => task.status === 'succeeded').length,
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
  decision: ControlDecision;
  recoveryTrigger?: QueuedExecutionRequest['recoveryTrigger'];
  queryId?: string | null;
}): QueuedExecutionRequest {
  return {
    userPrompt: input.userInput,
    contextTaskId: input.taskId,
    queryId: input.queryId,
    executionMode: input.executionMode,
    kernelDecisionId: input.decision.id,
    schedulingReason: input.decision.reason,
    recoveryTrigger: input.recoveryTrigger,
  };
}

function normalizeStatusScope(scope: string | null): TaskStatusQueryScope {
  // `blocked` stays accepted as the CLI spelling of the one user-facing state.
  if (scope === 'blocked' || scope === 'needs_action') return 'needs_action';
  if (scope === 'running' || scope === 'dashboard') return scope;
  throw new Error(`Invalid status scope: ${String(scope)}`);
}

function normalizeClearScope(scope: string | null): TaskClearScope {
  if (scope === 'parked' || scope === 'blocked' || scope === 'all') return scope;
  throw new Error(`Invalid clear scope: ${String(scope)}`);
}
