// Executes scheduled task work from memory-context preparation through work
// graph dispatch, executor runs, verification, persistence, and completion.
import type { MemoryEngine } from '../memory/memory-engine.js';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { MemoryContextService, ExecutionRecallSelection } from '../memory/memory-context-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { SchedulerEngine } from '../task/scheduler.js';
import type { ExecutionRuntime } from '../execution/execution-runtime.js';
import type { ExecutionProgressService, ExecutionProgressTracker } from '../execution/execution-progress-service.js';
import type { WorkspaceTargetService } from '../execution/workspace-target-service.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { MemoryCaptureService } from '../memory/memory-capture-service.js';
import type { AgentClass, GuidanceProposal, Subtask, Suggestion, Task } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import { generateInteractionId } from '../utils/id.js';
import { formatExecutorError, isRecoverableExecutorFailure } from '../executor/error-utils.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';
import type { WorkUnitClaim, WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { AcceptanceCriterion } from '../execution/execution-aggregator.js';
import type { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import type { PlanningAction } from '../planning/planning-types.js';
import type { KernelExecutorStatusProjector } from '../kernel/kernel-executor-status-projector.js';

// Plan actions that intend executor work when they reach dispatch. resume/fork
// carry 'task_control' (no longer relabeled to 'plan_work_graph'); everything
// else (direct_reply / clarification / no_action) is a non-executing outcome.
const EXECUTABLE_PLAN_ACTIONS = new Set<PlanningAction>(['plan_work_graph', 'task_control']);

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionExecutionCoordinatorInput {
  taskId: string;
  request: QueuedExecutionRequest;
  approvedRecallSelection: ExecutionRecallSelection | null;
}

export interface SessionExecutionCoordinatorDeps {
  sessionId: string;
  memoryEngine: MemoryEngine;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  memoryContextService: MemoryContextService;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  subtaskRepo: SubtaskRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  executionRuntime: ExecutionRuntime;
  scheduler: SchedulerEngine<QueuedExecutionRequest>;
  executionProgressService: ExecutionProgressService;
  workspaceTargetService: WorkspaceTargetService;
  verificationAndDeliveryService: VerificationAndDeliveryService;
  persistenceService: SessionPersistenceService;
  memoryCaptureService: MemoryCaptureService;
  kernelExecutorStatusProjector: KernelExecutorStatusProjector;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    refreshRuntimeState(): void;
    appendTaskQueueSnapshot(trigger: string): void;
    setFocusContext(focus: FocusContext | null): void;
    setRunningExecutorName(taskId: string, name: string): void;
    clearRunningExecutorName(taskId: string): void;
    persistSessionState(changes: {
      lastFocusedTaskId?: string | null;
      lastCompletedTaskId?: string | null;
      lastSessionId?: string | null;
    }): void;
    setLatestGuidance(scene: string, suggestion: Suggestion): GuidanceState;
    queueProposal(scene: string, proposal: GuidanceProposal): void;
  };
}

/** Owns the per-task execution lifecycle once scheduler admission has selected work to run. */
export class SessionExecutionCoordinator {
  private readonly taskEvents: TaskEventRecorder;

  constructor(private readonly deps: SessionExecutionCoordinatorDeps) {
    this.taskEvents = new TaskEventRecorder(deps.taskEventRepo);
  }

  async execute(input: SessionExecutionCoordinatorInput): Promise<void> {
    const { taskId, request, approvedRecallSelection } = input;
    const { userPrompt, contextTaskId, executionMode, schedulingReason, newlyProvidedResources } = request;
    const finishExecution = async (lines: string[], options: { scheduleNext?: boolean } = {}) => {
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
      if (options.scheduleNext ?? true) {
        await this.deps.scheduler.scheduleNext();
      }
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendTaskQueueSnapshot('task state changed');
    };

    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Error: task not found ${taskId}`);
      return;
    }

    this.deps.callbacks.appendOutput(
      '【MetaClaw｜提取最近历史记录上下文】',
      '【MetaClaw｜构建执行上下文】',
    );
    const memoryContext = await this.deps.memoryContextService.prepareExecutionContext({
      taskId,
      sessionId: this.deps.sessionId,
      userPrompt,
      contextTaskId,
      executionMode,
      schedulingReason,
      newlyProvidedResources,
      approvedRecallSelection,
      includeRecentConversationContext: request.includeRecentConversationContext,
    });
    const { preferences, conversationHistory, executionContextBundle } = memoryContext;
    for (const resolvedPreference of executionContextBundle.memoryContext.resolvedPreferences) {
      this.deps.memoryEngine.recordUsage(resolvedPreference.id, taskId);
    }
    this.deps.callbacks.appendOutput('【MetaClaw｜执行上下文准备完成】');

    let progressTracker: ExecutionProgressTracker | null = null;
    let activeClaim: WorkUnitClaim | null = null;
    let activeSubtask: Subtask | null = null;
    try {
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (!currentTask) {
        await finishExecution([`Error: task not found ${taskId}`]);
        return;
      }
      if (currentTask.status !== 'running') {
        this.deps.callbacks.clearRunningExecutorName(taskId);
        this.deps.callbacks.refreshRuntimeState();
        return;
      }

      this.deps.workspaceTargetService.ensureTargets(executionContextBundle.workspaceContext?.targetPaths ?? []);
      const executionId = `exec_${generateInteractionId()}`;
      this.deps.scheduler.markDispatchStarted(taskId, executionId);
      progressTracker = this.deps.executionProgressService.createTracker({
        taskId,
        executionId,
      });
      this.recoverExpiredWorkUnits();

      const agentClasses = this.deps.agentClassService.listAgentClasses();
      // Defense-in-depth: only executable plans dispatch an executor. resume/fork
      // requests keep their truthful 'task_control' action (we no longer relabel
      // them to 'plan_work_graph'), so the guard admits both plan_work_graph and
      // task_control. Non-executing plans (direct_reply / clarification / no_action)
      // are handled inline in KernelDecisionApplier and should never run here — if
      // one still reaches dispatch, skip execution instead of false-succeeding.
      if (request.planningPlan && !EXECUTABLE_PLAN_ACTIONS.has(request.planningPlan.action)) {
        this.deps.scheduler.clearDispatch(taskId, request.planningPlan.reason);
        await finishExecution([], { scheduleNext: false });
        return;
      }

      const workGraphResult = this.deps.workGraphRuntimeService.apply({
        task: currentTask,
        userPrompt,
        approvedPlan: request.planningPlan ?? null,
      });
      const executionOutputs: Array<{ subtaskId: string; title: string; output: string }> = [];
      const announcedExecutorNames = new Set<string>();
      let finalExecution: Awaited<ReturnType<ExecutionRuntime['run']>> | null = null;
      for (;;) {
        this.recoverExpiredWorkUnits();
        const loopTask = this.deps.taskRuntimeService.findTask(taskId);
        if (loopTask?.status !== 'running') {
          const stoppedSubtask = activeSubtask as Subtask | null;
          this.recordTaskEvent(taskId, stoppedSubtask?.id ?? null, 'dispatch_stopped', `task status is ${loopTask?.status ?? 'missing'}`, {});
          this.deps.scheduler.clearDispatch(taskId, `task status is ${loopTask?.status ?? 'missing'}`);
          return;
        }

        const readySubtask = this.findNextReadySubtask(taskId);
        if (!readySubtask) {
          const noReadyOutcome = await this.handleNoReadySubtask({
            taskId,
            executionId,
            finishExecution,
            hasExecution: finalExecution !== null,
          });
          if (noReadyOutcome === 'stop') return;
          break;
        }

        const claim = await this.deps.workUnitClaimService.claim({ taskId, subtask: readySubtask });
        if (!claim) {
          await this.deps.scheduler.markDispatchBlocked(taskId, 'no idle executor work unit can claim the ready subtask');
          await finishExecution([
            `Subtask waiting for executor work unit: ${readySubtask.title}`,
            this.deps.presentation.buildRecoverableFailureHint(taskId, 'no idle executor work unit'),
          ], { scheduleNext: false });
          return;
        }
        activeClaim = claim;
        activeSubtask = readySubtask;

        const agentClass = this.findAgentClassForClaim(agentClasses, claim.workUnit.agentClassName);
        if (!announcedExecutorNames.has(agentClass.name)) {
          this.deps.callbacks.appendOutput(...this.deps.presentation.formatExecutorDispatch(agentClass.name));
          announcedExecutorNames.add(agentClass.name);
        }
        this.deps.subtaskRepo.updateStatus(readySubtask.id, 'running');
        this.recordTaskEvent(taskId, readySubtask.id, 'subtask_claimed', readySubtask.title, {
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
        });
        claim.markRunning();
        this.deps.callbacks.setRunningExecutorName(taskId, agentClass.name);
        this.deps.callbacks.refreshRuntimeState();

        const execution = await this.deps.executionRuntime.run({
          taskId,
          executionId,
          spec: {
            subtask: readySubtask,
            workUnit: claim.workUnit,
            agentClass,
            acceptance: readySubtask.acceptance,
            expectedOutput: readySubtask.expectedOutput,
          },
          executorInput: {
            task: this.deps.taskRuntimeService.findTask(taskId)!,
            preferences,
            userPrompt: readySubtask.goal,
            conversationHistory,
            executionContextBundle,
          },
          onProgress: progressTracker.onProgress,
        });
        finalExecution = execution;
        this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
          agentClassName: agentClass.name,
          outcome: execution.status === 'success' ? 'succeeded' : 'failed',
          error: execution.status === 'success' ? null : execution.error,
        });

        const postRunTask = this.deps.taskRuntimeService.findTask(taskId);
        if (postRunTask?.status !== 'running') {
          this.recordTaskEvent(taskId, readySubtask.id, 'subtask_abandoned_after_task_status_change', readySubtask.title, {
            taskStatus: postRunTask?.status ?? 'missing',
            workUnitId: claim.workUnit.id,
          });
          claim.release();
          activeClaim = null;
          activeSubtask = null;
          this.deps.scheduler.clearDispatch(taskId, `task status is ${postRunTask?.status ?? 'missing'}`);
          return;
        }

        if (execution.status === 'success') {
          this.deps.subtaskRepo.updateStatus(readySubtask.id, 'done', { result: execution.output });
          this.recordTaskEvent(taskId, readySubtask.id, 'subtask_done', readySubtask.title, {
            executorName: execution.executorName,
          });
          executionOutputs.push({
            subtaskId: readySubtask.id,
            title: readySubtask.title,
            output: execution.output,
          });
          this.deps.callbacks.appendOutput(this.deps.presentation.formatExecutorFinalResult({
            executorName: execution.executorName,
            taskId,
            subtaskId: readySubtask.id,
            output: execution.output,
          }));
          claim.release();
          activeClaim = null;
          activeSubtask = null;
          continue;
        }

        const errorMessage = formatExecutorError(execution.error ?? undefined) ?? execution.error ?? 'unknown error';
        this.deps.subtaskRepo.updateStatus(readySubtask.id, 'blocked', { error: errorMessage });
        this.recordTaskEvent(taskId, readySubtask.id, 'subtask_failed', errorMessage, {
          executorName: execution.executorName,
        });
        claim.markFailed(errorMessage);
        claim.release();
        activeClaim = null;
        activeSubtask = null;
        if (isRecoverableExecutorFailure(errorMessage)) {
          await this.deps.scheduler.markDispatchBlocked(taskId, errorMessage);
          await finishExecution([
            `✗ 执行失败: ${errorMessage}`,
            this.deps.presentation.buildRecoverableFailureHint(taskId, errorMessage),
          ], { scheduleNext: false });
          return;
        }

        this.deps.taskRuntimeService.transitionTask(taskId, 'parked');
        await finishExecution([`✗ 执行失败: ${errorMessage}`]);
        return;
      }

      if (!finalExecution) {
        await this.deps.scheduler.markDispatchFinished(taskId, {
          taskId,
          executionId,
          status: 'success',
          reason: 'planner found no executable subtasks',
        });
        await finishExecution(['-> Planner: no executable ready subtask'], { scheduleNext: false });
        return;
      }

      const execution = {
        ...finalExecution,
        output: executionOutputs.length === 1
          ? executionOutputs[0]!.output
          : executionOutputs.map((entry, index) => {
              return `## ${entry.title || `Subtask ${index + 1}`}\n\n${entry.output}`;
            }).join('\n\n'),
        userPrompt,
      };
      this.deps.persistenceService.recordInteraction({
        taskId,
        sessionId: this.deps.sessionId,
        userInput: userPrompt,
        systemOutput: execution.output,
        executorUsed: execution.executorName,
      });

      await this.handleSuccessfulExecution({
        task,
        taskId,
        request,
        executionId,
        executionMode,
        userPrompt,
        execution,
        acceptanceCriteria: this.buildAcceptanceCriteria(taskId),
        progressTracker,
        finishExecution,
      });
    } catch (error) {
      const errorMessage = formatExecutorError((error as Error).message) ?? (error as Error).message;
      if (activeSubtask) {
        this.recordTaskEvent(taskId, activeSubtask.id, 'subtask_exception', errorMessage, {
          workUnitId: activeClaim?.workUnit.id ?? null,
        });
      }
      if (activeClaim) {
        activeClaim.markFailed(errorMessage);
        activeClaim.release();
        activeClaim = null;
        activeSubtask = null;
      }
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (currentTask?.status === 'running') {
        if (isRecoverableExecutorFailure(errorMessage)) {
          await this.deps.scheduler.markDispatchBlocked(taskId, errorMessage);
          await finishExecution([
            `✗ 执行异常: ${errorMessage}`,
            this.deps.presentation.buildRecoverableFailureHint(taskId, errorMessage),
          ], { scheduleNext: false });
          return;
        }

        this.deps.taskRuntimeService.transitionTask(taskId, 'parked');
        await finishExecution([`✗ 执行异常: ${errorMessage}`]);
        return;
      }

      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
    }
  }

  private async handleSuccessfulExecution(input: {
    task: Task;
    taskId: string;
    request: QueuedExecutionRequest;
    executionId: string;
    executionMode: QueuedExecutionRequest['executionMode'];
    userPrompt: string;
    execution: Awaited<ReturnType<ExecutionRuntime['run']>>;
    acceptanceCriteria: AcceptanceCriterion[];
    progressTracker: ExecutionProgressTracker;
    finishExecution(lines: string[], options?: { scheduleNext?: boolean }): Promise<void>;
  }): Promise<void> {
    const workspaceContext = input.execution.context.workspaceContext;
    const delivery = await this.deps.verificationAndDeliveryService.prepareAsync({
      output: input.execution.output,
      durationMs: input.execution.durationMs,
      userPrompt: input.userPrompt,
      workspaceContext,
      preferences: input.execution.context.memoryContext.resolvedPreferences,
      nextStep: '',
      acceptanceCriteria: input.acceptanceCriteria,
      evidenceText: input.progressTracker.evidenceText,
    });

    if (delivery.verification.status === 'blocked') {
      const blockReason = delivery.verification.reason ?? 'final result did not satisfy verification criteria';
      await this.deps.scheduler.markDispatchBlocked(input.taskId, blockReason);
      await input.finishExecution([
        `执行未完成: ${blockReason}`,
        `✗ 验收未通过: ${blockReason}`,
        this.deps.presentation.buildVerificationFailureHint(input.taskId),
      ], { scheduleNext: false });
      return;
    }

    const artifactPaths = delivery.artifactPaths;
    const taskSummary = delivery.summary;
    this.deps.taskRuntimeService.updateTask(input.taskId, {
      summary: taskSummary,
      injectedPreferences: input.execution.context.memoryContext.resolvedPreferences.map(preference => preference.id),
      artifacts: artifactPaths,
    });
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: input.taskId });

    const completionLines = this.deps.memoryCaptureService.captureCompletionPatterns({
      userPrompt: input.userPrompt,
      output: input.execution.output,
      taskId: input.taskId,
    }).lines;

    const suggestion = this.deps.orchestration.suggestNext(input.taskId);
    const nextProposal = this.deps.orchestration.suggestNextProposal(input.taskId);
    await this.deps.scheduler.markDispatchFinished(input.taskId, {
      taskId: input.taskId,
      executionId: input.executionId,
      status: 'success',
      reason: taskSummary,
    });
    this.deps.callbacks.persistSessionState({
      lastFocusedTaskId: input.taskId,
      lastCompletedTaskId: input.taskId,
    });
    completionLines.push(...this.deps.verificationAndDeliveryService.formatCompletion({
      output: input.execution.output,
      durationMs: input.execution.durationMs,
      workspaceContext,
      artifactPaths,
      summary: taskSummary,
      nextStep: this.buildCompletionNextStep(suggestion),
    }));
    if (input.executionMode === 'resume-blocked') {
      this.deps.verificationAndDeliveryService.appendBlockedRecoveryCompletionBlock(completionLines, {
        task: input.task,
        summary: taskSummary,
        output: input.execution.output,
        recoveryTrigger: input.request.recoveryTrigger,
      });
    }

    void this.deps.verificationAndDeliveryService.deliverTaskCompletion(this.deps.notifier, {
      taskId: input.taskId,
      title: input.task.title,
      summary: taskSummary,
      output: input.execution.output,
      artifactPaths,
      durationMs: input.execution.durationMs,
      executionMode: input.executionMode,
      origin: input.request.origin ?? 'user',
      recoveryTrigger: input.request.recoveryTrigger,
    }).then(message => {
      if (message) {
        this.deps.callbacks.appendOutput(message);
      }
    });

    if (suggestion) {
      const guidance = this.deps.callbacks.setLatestGuidance('completion suggestion', suggestion);
      completionLines.push(...this.deps.presentation.formatGuidanceBlock(
        'completion suggestion',
        suggestion,
        guidance.taskTitle,
        { emptyReason: 'follow-up task is available' },
      ));
    }

    await input.finishExecution(completionLines, { scheduleNext: false });
    if (nextProposal) {
      this.deps.callbacks.queueProposal('completion suggestion', nextProposal);
    }
  }

  private findNextReadySubtask(taskId: string): Subtask | null {
    const subtasks = this.deps.subtaskRepo.listByTask(taskId);
    const done = new Set(subtasks.filter(subtask => subtask.status === 'done').map(subtask => subtask.id));
    return subtasks.find(subtask =>
      subtask.status === 'ready' && subtask.dependsOn.every(dependencyId => done.has(dependencyId))
    ) ?? null;
  }

  private async handleNoReadySubtask(input: {
    taskId: string;
    executionId: string;
    finishExecution(lines: string[], options?: { scheduleNext?: boolean }): Promise<void>;
    hasExecution: boolean;
  }): Promise<'continue' | 'stop'> {
    const subtasks = this.deps.subtaskRepo.listByTask(input.taskId);
    const unfinished = subtasks.filter(subtask => subtask.status !== 'done');
    if (unfinished.length === 0) {
      if (input.hasExecution) {
        return 'continue';
      }
      await this.deps.scheduler.markDispatchFinished(input.taskId, {
        taskId: input.taskId,
        executionId: input.executionId,
        status: 'success',
        reason: 'all persisted subtasks are already done',
      });
      await input.finishExecution(['-> Planner: all persisted subtasks are already done'], { scheduleNext: false });
      return 'stop';
    }

    const reason = `planner found no ready subtask; unfinished subtasks: ${unfinished
      .map(subtask => `${subtask.id}:${subtask.status}`)
      .join(', ')}`;
    for (const subtask of unfinished) {
      this.deps.subtaskRepo.updateStatus(subtask.id, 'blocked', { error: subtask.error ?? reason });
    }
    this.recordTaskEvent(input.taskId, null, 'no_ready_subtask_blocked', reason, {
      unfinished: unfinished.map(subtask => ({ id: subtask.id, status: subtask.status })),
    });
    await this.deps.scheduler.markDispatchBlocked(input.taskId, reason);
    await input.finishExecution([
      `Subtask dispatch blocked: ${reason}`,
      this.deps.presentation.buildRecoverableFailureHint(input.taskId, reason),
    ], { scheduleNext: false });
    return 'stop';
  }

  private recoverExpiredWorkUnits(): void {
    const lost = this.deps.workUnitClaimService.sweepExpired();
    for (const workUnit of lost) {
      if (!workUnit.claimedTaskId || !workUnit.claimedSubtaskId) {
        continue;
      }
      const subtask = this.deps.subtaskRepo.findById(workUnit.claimedSubtaskId);
      if (subtask && subtask.status !== 'done') {
        this.deps.subtaskRepo.updateStatus(subtask.id, 'ready');
      }
      this.recordTaskEvent(
        workUnit.claimedTaskId,
        workUnit.claimedSubtaskId,
        'work_unit_heartbeat_lost',
        `work unit ${workUnit.id} heartbeat lost`,
        { workUnitId: workUnit.id },
      );
    }
  }

  private findAgentClassForClaim(agentClasses: AgentClass[], agentClassName: string): AgentClass {
    const agentClass = agentClasses.find(item => item.name === agentClassName);
    if (!agentClass) {
      throw new Error(`claimed work unit references missing agent class: ${agentClassName}`);
    }
    return agentClass;
  }

  private buildAcceptanceCriteria(taskId: string): AcceptanceCriterion[] {
    const subtasks = this.deps.subtaskRepo.listByTask(taskId);
    return subtasks.map(subtask => ({
      id: `accept_${subtask.id}`,
      description: subtask.acceptance.join('; ') || `Complete subtask ${subtask.title}`,
      requiredEvidence: subtask.expectedOutput === 'patch' ? ['test command or reason tests were not run'] : [],
      severity: 'must',
      appliesToSubtaskIds: [subtask.id],
    }));
  }

  private recordTaskEvent(
    taskId: string,
    subtaskId: string | null,
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
  ): void {
    this.taskEvents.record(taskId, subtaskId, eventType, message, payload);
  }

  private buildCompletionNextStep(suggestion: { recommendedAction: string } | null): string {
    return suggestion?.recommendedAction ?? 'Continue with a follow-up task if more work is needed.';
  }
}
