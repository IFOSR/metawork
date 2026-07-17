import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { SchedulerEngine } from '../task/scheduler.js';
import type { ExecutionProgressService } from '../execution/execution-progress-service.js';
import type { SessionPersistenceService } from './session-persistence-service.js';
import type { MemoryCaptureService } from '../memory/memory-capture-service.js';
import type { GuidanceProposal, Subtask, Suggestion } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import { generateInteractionId } from '../utils/id.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { SessionPresentationService, GuidanceState } from './session-presentation-service.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { TaskEventRepo } from '../storage/task-event-repo.js';
import { TaskEventRecorder } from '../storage/task-event-recorder.js';
import type { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import type { PlanningAction } from '../planning/planning-types.js';
import type { KernelExecutorStatusProjector } from '../kernel/kernel-executor-status-projector.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { SubtaskAttemptRunner, SubtaskAttemptOutcome } from '../execution/subtask-attempt-runner.js';

const EXECUTABLE_PLAN_ACTIONS = new Set<PlanningAction>(['plan_work_graph', 'task_control']);

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

export interface SessionExecutionCoordinatorInput {
  taskId: string;
  request: QueuedExecutionRequest;
  approvedRecallSelection: unknown;
}

export interface SessionExecutionCoordinatorDeps {
  sessionId: string;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  subtaskRepo: SubtaskRepo;
  subtaskHandoffRepo: SubtaskHandoffRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  attemptRunner: SubtaskAttemptRunner;
  scheduler: SchedulerEngine<QueuedExecutionRequest>;
  executionProgressService: ExecutionProgressService;
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

/** Phase 2 serial scheduler shell. Attempt details are exclusively owned by SubtaskAttemptRunner. */
export class SessionExecutionCoordinator {
  private readonly taskEvents: TaskEventRecorder;

  constructor(private readonly deps: SessionExecutionCoordinatorDeps) {
    this.taskEvents = new TaskEventRecorder(deps.taskEventRepo);
  }

  async execute(input: SessionExecutionCoordinatorInput): Promise<void> {
    const { taskId, request } = input;
    const finishExecution = async (lines: string[], scheduleNext = false) => {
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
      if (scheduleNext) await this.deps.scheduler.scheduleNext();
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendTaskQueueSnapshot('task state changed');
    };

    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Error: task not found ${taskId}`);
      return;
    }
    if (request.planningPlan && !EXECUTABLE_PLAN_ACTIONS.has(request.planningPlan.action)) {
      this.deps.scheduler.clearDispatch(taskId, request.planningPlan.reason);
      await finishExecution([]);
      return;
    }

    const graph = this.deps.workGraphRuntimeService.apply({
      task,
      userPrompt: request.userPrompt,
      sessionId: this.deps.sessionId,
      approvedPlan: request.planningPlan ?? null,
    });
    if (graph.outcome === 'not_executable') {
      const reason = graph.reason === 'missing_graph'
        ? 'task has no v4 work graph; continue in natural language to trigger replanning'
        : 'task already has an immutable v4 work graph';
      this.deps.taskRuntimeService.transitionTask(taskId, 'parked');
      this.recordTaskEvent(taskId, null, 'dispatch_requires_replan', reason, { workGraphRuntimeReason: graph.reason });
      this.deps.scheduler.clearDispatch(taskId, reason);
      await finishExecution([reason]);
      return;
    }

    const executionId = `exec_${generateInteractionId()}`;
    this.deps.scheduler.markDispatchStarted(taskId, executionId);
    const progressTracker = this.deps.executionProgressService.createTracker({ taskId, executionId });
    this.blockExpiredAttempts();

    for (;;) {
      const currentTask = this.deps.taskRuntimeService.findTask(taskId);
      if (currentTask?.status !== 'running') {
        this.deps.scheduler.clearDispatch(taskId, `task status is ${currentTask?.status ?? 'missing'}`);
        await finishExecution([]);
        return;
      }
      const ready = this.findNextReadySubtask(taskId);
      if (!ready) break;
      const agentClassName = this.selectAgentClass(ready);
      if (!agentClassName) {
        await this.blockTask(taskId, `no authorized AgentClass is available for Subtask ${ready.id}`, finishExecution);
        return;
      }
      this.deps.callbacks.setRunningExecutorName(taskId, agentClassName);
      this.deps.callbacks.appendOutput(...this.deps.presentation.formatExecutorDispatch(agentClassName));
      const outcome = await this.deps.attemptRunner.run({
        executionId,
        taskId,
        subtaskId: ready.id,
        agentClassName,
        executionMode: request.executionMode,
        onProgress: progressTracker.onProgress,
      });
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.projectExecutorOutcome(agentClassName, outcome);
      if (outcome.outcome === 'completed') {
        this.recordTaskEvent(taskId, ready.id, 'subtask_done', ready.title, {
          attemptId: outcome.attemptId,
          executorName: outcome.executorName,
          warnings: outcome.warnings,
        });
        this.deps.callbacks.appendOutput(this.deps.presentation.formatExecutorFinalResult({
          executorName: outcome.executorName,
          taskId,
          subtaskId: ready.id,
          output: outcome.output,
        }));
        continue;
      }
      const reason = formatAttemptFailure(outcome);
      await this.blockTask(taskId, reason, finishExecution);
      return;
    }

    const subtasks = this.deps.subtaskRepo.listByTask(taskId);
    const unfinished = subtasks.filter(subtask => subtask.status !== 'done');
    if (unfinished.length > 0) {
      const reason = `no ready Subtask; unfinished nodes remain blocked: ${unfinished.map(item => `${item.id}:${item.status}`).join(', ')}`;
      await this.blockTask(taskId, reason, finishExecution);
      return;
    }
    await this.completeTask({ taskId, executionId, request, subtasks, finishExecution });
  }

  private findNextReadySubtask(taskId: string): Subtask | null {
    const subtasks = this.deps.subtaskRepo.listByTask(taskId);
    const done = new Set(subtasks.filter(subtask => subtask.status === 'done').map(subtask => subtask.id));
    const handoffs = new Set(this.deps.subtaskHandoffRepo.listByTask(taskId)
      .map(handoff => `${handoff.fromSubtaskId}\u0000${handoff.toSubtaskId}`));
    return subtasks.find(subtask =>
      subtask.status === 'ready'
      && subtask.dependencies.every(dependency =>
        done.has(dependency.fromSubtaskId)
        && handoffs.has(`${dependency.fromSubtaskId}\u0000${subtask.id}`)
      )
    ) ?? null;
  }

  private selectAgentClass(subtask: Subtask): string | null {
    const available = new Set(this.deps.agentClassService.listAgentClasses().map(item => item.name));
    return subtask.preferredAgentClassList.find(name => available.has(name)) ?? null;
  }

  private blockExpiredAttempts(): void {
    for (const workUnit of this.deps.workUnitClaimService.sweepExpired()) {
      if (!workUnit.claimedTaskId || !workUnit.claimedSubtaskId) continue;
      const subtask = this.deps.subtaskRepo.findById(workUnit.claimedSubtaskId);
      if (subtask && subtask.status !== 'done') {
        this.deps.subtaskRepo.updateStatus(subtask.id, 'blocked', {
          error: `attempt ${workUnit.claimedAttemptId ?? '(unknown)'} lost its heartbeat`,
        });
      }
      this.recordTaskEvent(workUnit.claimedTaskId, workUnit.claimedSubtaskId, 'work_unit_heartbeat_lost', workUnit.id, {
        workUnitId: workUnit.id,
        attemptId: workUnit.claimedAttemptId,
      });
    }
  }

  private async blockTask(
    taskId: string,
    reason: string,
    finishExecution: (lines: string[]) => Promise<void>,
  ): Promise<void> {
    // Scheduler owns the Task blocked transition so the blocker record and
    // interruption reason are persisted together with the dispatch state.
    await this.deps.scheduler.markDispatchBlocked(taskId, reason);
    this.recordTaskEvent(taskId, null, 'phase2_execution_blocked', reason, {});
    await finishExecution([`Execution blocked: ${reason}`]);
  }

  private async completeTask(input: {
    taskId: string;
    executionId: string;
    request: QueuedExecutionRequest;
    subtasks: Subtask[];
    finishExecution(lines: string[]): Promise<void>;
  }): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(input.taskId)!;
    const artifacts = [...new Set(input.subtasks.flatMap(subtask => subtask.artifacts))];
    const warnings = input.subtasks.flatMap(subtask => subtask.verification.warnings.map(warning => `${subtask.id}: ${warning}`));
    const persistedSummary = input.subtasks.map(subtask => {
      const firstLine = subtask.result.split(/\r?\n/).find(line => line.trim())?.trim() ?? 'completed';
      return `- ${subtask.title}: ${firstLine.slice(0, 240)}`;
    }).join('\n');
    const displaySummary = input.subtasks.map(subtask => `- ${subtask.title}: completed`).join('\n');
    const aggregateParts = (summary: string) => [
      `Task #${input.taskId} completed ${input.subtasks.length} Subtask(s).`,
      summary,
      warnings.length > 0 ? `Warnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}` : '',
      artifacts.length > 0 ? `Artifacts:\n${artifacts.map(path => `- ${path}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const cleanAggregate = aggregateParts(persistedSummary);
    const displayAggregate = aggregateParts(displaySummary);
    const memoryAggregate = [
      cleanAggregate,
      'Subtask clean results:',
      ...input.subtasks.map(subtask => `## ${subtask.id}\n${subtask.result}`),
    ].join('\n\n');

    this.deps.taskRuntimeService.updateTask(input.taskId, { summary: cleanAggregate, artifacts });
    this.deps.persistenceService.recordInteraction({
      taskId: input.taskId,
      sessionId: this.deps.sessionId,
      userInput: input.request.userPrompt,
      systemOutput: cleanAggregate,
      executorUsed: input.subtasks.length === 1 ? input.subtasks[0]!.preferredAgentClassList[0] ?? 'executor' : 'work-graph',
    });
    const completionLines = this.deps.memoryCaptureService.captureCompletionPatterns({
      userPrompt: input.request.userPrompt,
      output: memoryAggregate,
      taskId: input.taskId,
    }).lines;
    await this.deps.scheduler.markDispatchFinished(input.taskId, {
      taskId: input.taskId,
      executionId: input.executionId,
      status: 'success',
      reason: cleanAggregate,
    });
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: input.taskId });
    this.deps.callbacks.persistSessionState({ lastFocusedTaskId: input.taskId, lastCompletedTaskId: input.taskId });
    completionLines.push(displayAggregate);

    void this.deps.verificationAndDeliveryService.deliverTaskCompletion(this.deps.notifier, {
      taskId: input.taskId,
      title: task.title,
      summary: cleanAggregate,
      output: cleanAggregate,
      artifactPaths: artifacts,
      durationMs: 0,
      executionMode: input.request.executionMode,
      origin: input.request.origin ?? 'user',
      recoveryTrigger: input.request.recoveryTrigger,
    }).then(message => {
      if (message) this.deps.callbacks.appendOutput(message);
    });

    const suggestion = this.deps.orchestration.suggestNext(input.taskId);
    const nextProposal = this.deps.orchestration.suggestNextProposal(input.taskId);
    if (suggestion) {
      const guidance = this.deps.callbacks.setLatestGuidance('completion suggestion', suggestion);
      completionLines.push(...this.deps.presentation.formatGuidanceBlock(
        'completion suggestion', suggestion, guidance.taskTitle, { emptyReason: 'follow-up task is available' },
      ));
    }
    await input.finishExecution(completionLines);
    if (nextProposal) this.deps.callbacks.queueProposal('completion suggestion', nextProposal);
  }

  private projectExecutorOutcome(agentClassName: string, outcome: SubtaskAttemptOutcome): void {
    const succeeded = outcome.outcome === 'completed';
    this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
      agentClassName,
      outcome: succeeded ? 'succeeded' : 'failed',
      error: succeeded ? null : formatAttemptFailure(outcome),
    });
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
}

function formatAttemptFailure(outcome: Exclude<SubtaskAttemptOutcome, { outcome: 'completed' }>): string {
  if (outcome.outcome === 'contract_blocked') {
    return outcome.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
  }
  return outcome.outcome === 'executor_failed' ? outcome.error : outcome.reason;
}
