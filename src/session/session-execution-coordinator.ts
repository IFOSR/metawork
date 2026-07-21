import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
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
import type { KernelExecutorStatusProjector } from '../execution/kernel-executor-status-projector.js';
import type { VerificationAndDeliveryService } from '../delivery/verification-and-delivery-service.js';
import type { WorkUnitClaimService } from '../execution/work-unit-claim-service.js';
import type { SubtaskAttemptRunner, SubtaskAttemptOutcome } from '../execution/subtask-attempt-runner.js';
import {
  ControlKernel,
  type KernelAttemptFact,
  type KernelDecision,
  type KernelEvent,
  type KernelSnapshot,
} from '../kernel/control-kernel.js';
import { DurableKernelWorkflow, type KernelWorkflow, type KernelWorkflowStore } from '../kernel/kernel-workflow.js';
import type { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { deriveRecoverySafety } from '../executor/builtin-executor-catalog.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

interface DispatchStableFacts {
  executorStatuses: Extract<KernelSnapshot, { type: 'dispatch' }>['executorStatuses'];
  correctionSupportedAgentClasses: string[];
  nativeContinuationAgentClasses: string[];
}

export interface KernelExecutionRuntimeInput {
  taskId: string;
  request: QueuedExecutionRequest;
  approvedRecallSelection: unknown;
}

export interface KernelExecutionRuntimeDeps {
  sessionId: string;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  subtaskRepo: SubtaskRepo;
  workGraphRevisionRepo: WorkGraphRevisionRepo;
  subtaskHandoffRepo: SubtaskHandoffRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  attemptRunner: SubtaskAttemptRunner;
  controlKernel: ControlKernel;
  kernelWorkflowStore: KernelWorkflowStore;
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
    requestReplan(decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
    }): Promise<KernelEvent>;
    buildPlanAdmissionSnapshot(event: Extract<KernelEvent, { type: 'plan_proposed' }>): KernelSnapshot;
  };
}

/** Runtime handler set for Kernel decisions. It applies one authorized action and reports one fact. */
export class KernelExecutionRuntime {
  private readonly taskEvents: TaskEventRecorder;

  constructor(private readonly deps: KernelExecutionRuntimeDeps) {
    this.taskEvents = new TaskEventRecorder(deps.taskEventRepo);
  }

  private buildDispatchSnapshot(
    taskId: string,
    attemptedAgentClasses: Set<string>,
    graphState: 'ready' | 'missing' | 'conflict' = 'ready',
    stableFacts: DispatchStableFacts = this.buildDispatchStableFacts(),
    attempts: KernelAttemptFact[] = [],
  ): KernelSnapshot {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const subtasks = activeRevision
      ? this.deps.subtaskRepo.listActiveByTask(taskId)
      : this.deps.subtaskRepo.listByTask(taskId);
    const done = new Set(subtasks.filter(subtask => subtask.status === 'done').map(subtask => subtask.id));
    const handoffs = new Set(this.deps.subtaskHandoffRepo.listByTask(taskId)
      .map(handoff => `${handoff.fromSubtaskId}\u0000${handoff.toSubtaskId}`));
    const readyFrontier = subtasks.filter(subtask =>
      subtask.status === 'ready'
      && subtask.dependencies.every(dependency =>
        done.has(dependency.fromSubtaskId)
        && handoffs.has(`${dependency.fromSubtaskId}\u0000${subtask.id}`)
      )
    ).map(subtask => subtask.id);
    return {
      schemaVersion: 2,
      type: 'dispatch',
      task: task ? { id: task.id, status: task.status } : null,
      runningTaskId: this.deps.taskRuntimeService.getCurrentRunningTask()?.id ?? null,
      graphState,
      subtasks: subtasks.map(subtask => ({
        id: subtask.id,
        taskId: subtask.taskId,
        status: subtask.status,
        preferredAgentClassList: subtask.preferredAgentClassList,
      })),
      readyFrontier,
      attemptedAgentClasses: [...attemptedAgentClasses],
      executorStatuses: stableFacts.executorStatuses,
      correctionSupportedAgentClasses: stableFacts.correctionSupportedAgentClasses,
      nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
      attempts,
      generationId: activeRevision?.generationId ?? `generation_${taskId}_1`,
      graphRevision: activeRevision?.revision ?? 1,
      automaticReplansUsed: activeRevision
        ? this.deps.workGraphRevisionRepo.countAutomaticReplans(taskId, activeRevision.generationId)
        : 0,
      recoverySafety: deriveRecoverySafety(
        subtasks.find(subtask => readyFrontier.includes(subtask.id))?.requiredCapabilities ?? [],
      ),
      automaticRecoveryAllowed: subtasks.some(subtask => readyFrontier.includes(subtask.id))
        ? deriveRecoverySafety(
            subtasks.find(subtask => readyFrontier.includes(subtask.id))?.requiredCapabilities ?? [],
          ) !== 'external_non_idempotent'
        : true,
    };
  }

  private buildDispatchStableFacts(): DispatchStableFacts {
    return {
      executorStatuses: this.deps.kernelExecutorStatusProjector.list(),
      correctionSupportedAgentClasses: this.deps.agentClassService.listAgentClasses()
        .map(agentClass => agentClass.name)
        .filter(name => this.deps.attemptRunner.supportsResponseOnly(name)),
      nativeContinuationAgentClasses: this.deps.agentClassService.listAgentClasses()
        .map(agentClass => agentClass.name)
        .filter(name => this.deps.attemptRunner.supportsContinuation(name)),
    };
  }

  private async applyExecutionDecision(input: {
    decision: KernelDecision;
    executionId: string;
    request: QueuedExecutionRequest;
    progressTracker: ReturnType<ExecutionProgressService['createTracker']>;
    attemptedAgentClasses: Set<string>;
    correctionInputs: Map<string, {
      sourceAttemptId: string;
      completionContract: unknown;
      violations: Extract<SubtaskAttemptOutcome, { outcome: 'contract_failed' }>['violations'];
    }>;
    attemptFacts: KernelAttemptFact[];
    finishExecution(lines: string[], scheduleNext?: boolean): Promise<void>;
  }): Promise<KernelEvent | null> {
    const { decision } = input;
    const action = decision.action;
    if (action.type === 'dispatch_attempt') {
      const subtask = this.deps.subtaskRepo.findById(action.subtaskId);
      if (!subtask) throw new Error(`Kernel-authorized Subtask not found: ${action.subtaskId}`);
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (!task) throw new Error(`Kernel-authorized Task not found: ${action.taskId}`);
      for (const resource of input.request.newlyProvidedResources ?? []) {
        this.deps.taskRuntimeService.attachResource(task.id, resource);
      }
      if (task.status === 'created') this.deps.taskRuntimeService.transitionTask(task.id, 'ready');
      else if (task.status === 'parked') this.deps.taskRuntimeService.resumeParkedTask(task.id);
      else if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
      const runnable = this.deps.taskRuntimeService.findTask(task.id);
      if (runnable?.status === 'ready') this.deps.taskRuntimeService.transitionTask(task.id, 'running');
      input.attemptedAgentClasses.add(action.agentClassName);
      this.deps.callbacks.setRunningExecutorName(action.taskId, action.agentClassName);
      this.deps.callbacks.appendOutput(...this.deps.presentation.formatExecutorDispatch(action.agentClassName));
      const correction = input.correctionInputs.get(action.subtaskId);
      const outcome = action.attemptKind === 'contract_correction' && correction
        ? await this.deps.attemptRunner.runCorrection({
            attemptId: action.attemptId,
            sourceAttemptId: correction.sourceAttemptId,
            executionId: input.executionId,
            taskId: action.taskId,
            subtaskId: action.subtaskId,
            agentClassName: action.agentClassName,
            completionContract: correction.completionContract,
            violations: correction.violations,
          })
        : await this.deps.attemptRunner.run({
            attemptId: action.attemptId,
            executionId: input.executionId,
            taskId: action.taskId,
            subtaskId: action.subtaskId,
            agentClassName: action.agentClassName,
            executionMode: input.request.executionMode,
            attemptKind: action.attemptKind,
            sourceAttemptId: action.sourceAttemptId,
            recoveryMode: action.recoveryMode,
            onProgress: input.progressTracker.onProgress,
          });
      this.deps.callbacks.clearRunningExecutorName(action.taskId);
      if (outcome.outcome === 'capacity_unavailable') {
        return this.eventFromDecision(decision, {
          type: 'capacity_signal', taskId: action.taskId, subtaskId: action.subtaskId,
          agentClassName: action.agentClassName, available: false, cycleId: input.executionId,
          attemptKind: action.attemptKind,
        });
      }
      this.projectExecutorOutcome(action.agentClassName, outcome);
      if (outcome.outcome === 'contract_failed') {
        input.correctionInputs.set(action.subtaskId, {
          sourceAttemptId: outcome.attemptId,
          completionContract: outcome.completionContract,
          violations: outcome.violations,
        });
        return this.eventFromDecision(decision, {
          type: 'handoff_contract_failed', taskId: action.taskId, subtaskId: action.subtaskId,
          attemptId: outcome.attemptId, workUnitId: outcome.workUnitId, agentClassName: outcome.agentClassName,
          contract: outcome.completionContract, violations: outcome.violations, receiptCount: outcome.receiptCount,
          responseBytes: outcome.responseBytes,
        });
      }
      if (outcome.outcome === 'completed') {
        input.attemptedAgentClasses.clear();
        this.recordTaskEvent(action.taskId, action.subtaskId, 'subtask_done', subtask.title, {
          attemptId: outcome.attemptId, executorName: outcome.executorName, warnings: outcome.warnings,
        });
        this.deps.callbacks.appendOutput(this.deps.presentation.formatExecutorFinalResult({
          executorName: outcome.executorName, taskId: action.taskId, subtaskId: action.subtaskId, output: outcome.output,
        }));
      }
      const executionEvent = this.eventFromDecision(decision, {
        type: 'execution_outcome', taskId: action.taskId, subtaskId: action.subtaskId,
        attemptId: outcome.attemptId,
        terminalKind: outcome.outcome === 'completed' ? 'completed' : 'failed',
        agentClassName: action.agentClassName,
        attemptKind: action.attemptKind,
        sourceAttemptId: action.sourceAttemptId,
        failure: outcome.outcome === 'completed'
          ? null
          : outcome.outcome === 'executor_failed'
            ? outcome.failure
            : { kind: 'stale', scope: 'attempt', code: 'cancelled_or_stale', summary: outcome.reason },
      });
      if (executionEvent.type === 'execution_outcome') {
        input.attemptFacts.unshift({
          attemptId: outcome.attemptId,
          agentClassName: action.agentClassName,
          attemptKind: action.attemptKind,
          sourceAttemptId: action.sourceAttemptId,
          terminalKind: executionEvent.terminalKind,
          failure: executionEvent.failure,
          completedAt: executionEvent.occurredAt,
        });
      }
      return executionEvent;
    }
    if (action.type === 'probe_capacity') {
      input.attemptedAgentClasses.add(action.agentClassName);
      const available = await this.deps.workUnitClaimService.probe(action.agentClassName);
      return this.eventFromDecision(decision, {
        type: 'capacity_signal', taskId: action.taskId, subtaskId: action.subtaskId,
        agentClassName: action.agentClassName, available, cycleId: input.executionId,
        attemptKind: 'primary',
      });
    }
    if (action.type === 'wait_for_capacity') {
      await this.blockTask(action.taskId, `capacity unavailable for Subtask ${action.subtaskId}`, input.finishExecution);
      return null;
    }
    if (action.type === 'wait_for_retry') {
      await this.blockTask(action.taskId, `retry scheduled for ${action.resumeAt}`, input.finishExecution);
      return this.eventFromDecision(decision, {
        type: 'timer_tick',
        taskId: action.taskId,
        subtaskId: action.subtaskId,
        occurredAt: action.resumeAt,
        wakeKind: 'retry',
        sourceDecisionId: decision.id,
        scheduledFor: action.resumeAt,
        retry: { agentClassName: action.agentClassName, sourceAttemptId: action.sourceAttemptId },
      });
    }
    if (action.type === 'block_work') {
      if (action.subtaskId && this.deps.subtaskRepo.findById(action.subtaskId)?.status === 'awaiting_decision') {
        this.deps.subtaskRepo.updateStatus(action.subtaskId, 'blocked', { error: decision.reason });
      }
      await this.blockTask(action.taskId, decision.reason, input.finishExecution);
      return null;
    }
    if (action.type === 'park_for_replan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (task && task.status !== 'parked') this.deps.taskRuntimeService.transitionTask(task.id, 'parked');
      await input.finishExecution([decision.reason]);
      return null;
    }
    if (action.type === 'complete_task') {
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
      const subtasks = this.deps.subtaskRepo.listByTask(action.taskId).filter(subtask =>
        subtask.status === 'done'
        && (!activeRevision || subtask.generationId === activeRevision.generationId)
      );
      if (activeRevision) this.deps.workGraphRevisionRepo.complete(action.taskId, activeRevision.revision, new Date().toISOString());
      await this.completeTask({
        taskId: action.taskId, executionId: input.executionId, request: input.request, subtasks,
        finishExecution: input.finishExecution,
      });
      return null;
    }
    if (action.type === 'request_replan') {
      return this.deps.callbacks.requestReplan(
        decision as KernelDecision & {
          action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
        },
      );
    }
    if (action.type === 'authorize_task_plan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (!task) throw new Error(`replan Task not found: ${action.taskId}`);
      const result = this.deps.workGraphRuntimeService.apply({
        task,
        userPrompt: input.request.userPrompt,
        sessionId: this.deps.sessionId,
        authorizedWorkGraph: action.workGraph,
        authorization: {
          decisionId: decision.id,
          generationId: action.generationId,
          revision: action.graphRevision,
          source: action.proposalSource,
          automaticReplan: action.proposalSource === 'replan',
        },
      });
      if (result.outcome === 'not_executable') throw new Error(`authorized replan could not apply: ${result.reason}`);
      input.attemptedAgentClasses.clear();
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested',
        taskId: action.taskId,
        reason: `graph revision ${action.graphRevision} activated`,
      });
    }
    if (action.type === 'no_op') return null;
    throw new Error(`Execution Runtime cannot apply ${action.type}`);
  }

  private eventFromDecision(
    decision: KernelDecision,
    event: Omit<KernelEvent, keyof import('../kernel/control-kernel.js').KernelEventEnvelope | 'schemaVersion' | 'id' | 'correlationId' | 'causationId' | 'occurredAt' | 'sessionId'> & Record<string, unknown>,
  ): KernelEvent {
    return {
      schemaVersion: 2,
      id: `event_${decision.id}_${String(event.type)}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      ...event,
    } as KernelEvent;
  }


  async execute(input: KernelExecutionRuntimeInput): Promise<void> {
    const { taskId, request } = input;
    const finishExecution = async (lines: string[], _scheduleNext = false) => {
      this.deps.callbacks.clearRunningExecutorName(taskId);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendTaskQueueSnapshot('task state changed');
    };

    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Error: task not found ${taskId}`);
      return;
    }
    const graph = this.deps.workGraphRuntimeService.apply({
      task,
      userPrompt: request.userPrompt,
      sessionId: this.deps.sessionId,
      authorizedWorkGraph: request.authorizedWorkGraph ?? null,
      authorization: request.workGraphAuthorization ?? null,
    });
    const graphState = graph.outcome === 'not_executable'
      ? graph.reason === 'missing_graph' ? 'missing' : 'conflict'
      : 'ready';

    const executionId = `exec_${generateInteractionId()}`;
    const progressTracker = this.deps.executionProgressService.createTracker({ taskId, executionId });
    const attemptedAgentClasses = new Set<string>();
    const correctionInputs = new Map<string, {
      sourceAttemptId: string;
      completionContract: unknown;
      violations: Extract<SubtaskAttemptOutcome, { outcome: 'contract_failed' }>['violations'];
    }>();
    const attemptFacts: KernelAttemptFact[] = [];
    const stableFacts = this.buildDispatchStableFacts();
    const initialEvent: KernelEvent = {
      schemaVersion: 2,
      type: 'dispatch_requested',
      id: `dispatch_event_${executionId}`,
      correlationId: request.kernelDecisionId ?? executionId,
      causationId: request.kernelDecisionId ?? null,
      occurredAt: new Date().toISOString(),
      sessionId: this.deps.sessionId,
      taskId,
      reason: request.schedulingReason ?? 'authorized execution request',
    };
    const buildSnapshot = (event: KernelEvent): KernelSnapshot => event.type === 'plan_proposed'
      ? this.deps.callbacks.buildPlanAdmissionSnapshot(event)
      : event.type === 'timer_tick' ? {
          schemaVersion: 2,
          type: 'timer',
          capacityBlockedAt: null,
          recheckAfterMs: 0,
            capacityAgentClasses: [],
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
          executorStatuses: stableFacts.executorStatuses,
        }
      : this.buildDispatchSnapshot(
          event.taskId ?? taskId,
          attemptedAgentClasses,
          graphState,
          stableFacts,
          attemptFacts,
        );
    const workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot,
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: decision => this.applyExecutionDecision({
          decision,
          executionId,
          request,
          progressTracker,
          attemptedAgentClasses,
          correctionInputs,
          attemptFacts,
          finishExecution,
        }),
      },
    });
    await this.recoverExpiredAttempts(workflow, attemptFacts);
    await workflow.submit(initialEvent);
  }

  private async recoverExpiredAttempts(workflow: KernelWorkflow, attemptFacts: KernelAttemptFact[]): Promise<void> {
    for (const workUnit of this.deps.workUnitClaimService.sweepExpired()) {
      if (!workUnit.claimedTaskId || !workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
      const task = this.deps.taskRuntimeService.findTask(workUnit.claimedTaskId);
      const subtask = this.deps.subtaskRepo.findById(workUnit.claimedSubtaskId);
      if (!task || !subtask || subtask.status === 'done') continue;
      this.deps.attemptRunner.landHeartbeatLost({
        attemptId: workUnit.claimedAttemptId,
        executionId: `heartbeat_${workUnit.claimedAttemptId}`,
        taskId: task.id,
        subtaskId: subtask.id,
        workUnitId: workUnit.id,
        agentClassName: workUnit.agentClassName,
      });
      const occurredAt = new Date().toISOString();
      const event: Extract<KernelEvent, { type: 'execution_outcome' }> = {
        schemaVersion: 2,
        type: 'execution_outcome',
        id: `heartbeat_event_${workUnit.claimedAttemptId}`,
        correlationId: task.id,
        causationId: workUnit.claimedAttemptId,
        occurredAt,
        sessionId: this.deps.sessionId,
        taskId: task.id,
        subtaskId: subtask.id,
        attemptId: workUnit.claimedAttemptId,
        terminalKind: 'failed',
        agentClassName: workUnit.agentClassName,
        attemptKind: 'primary',
        sourceAttemptId: null,
        failure: { kind: 'heartbeat_lost', scope: 'agent_class', code: 'heartbeat_lost', summary: 'WorkUnit heartbeat lost' },
      };
      attemptFacts.unshift({
        attemptId: workUnit.claimedAttemptId,
        agentClassName: workUnit.agentClassName,
        attemptKind: 'primary',
        sourceAttemptId: null,
        terminalKind: 'failed',
        failure: event.failure,
        completedAt: occurredAt,
      });
      await workflow.submit(event);
      this.recordTaskEvent(task.id, subtask.id, 'work_unit_heartbeat_lost', workUnit.id, {
        workUnitId: workUnit.id,
        attemptId: workUnit.claimedAttemptId,
      });
    }
  }

  async recheckCapacity(input: {
    taskId: string;
    subtaskId: string;
    blockedDecisionId: string;
    blockedAt: string;
    recheckAfterMs: number;
    occurredAt: string;
  }): Promise<boolean> {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!task || task.status !== 'blocked' || !subtask || subtask.status !== 'ready') return false;

    const executionId = `timer_${input.blockedDecisionId}`;
    const request: QueuedExecutionRequest = {
      userPrompt: task.goal,
      contextTaskId: task.id,
      executionMode: 'resume-blocked',
      kernelDecisionId: input.blockedDecisionId,
      origin: 'system',
      schedulingReason: 'Kernel capacity timer recheck',
    };
    const progressTracker = this.deps.executionProgressService.createTracker({ taskId: task.id, executionId });
    const attemptedAgentClasses = new Set<string>();
    const correctionInputs = new Map<string, {
      sourceAttemptId: string;
      completionContract: unknown;
      violations: Extract<SubtaskAttemptOutcome, { outcome: 'contract_failed' }>['violations'];
    }>();
    const stableFacts = this.buildDispatchStableFacts();
    let applied = false;
    const finishExecution = async (lines: string[]) => {
      this.deps.callbacks.clearRunningExecutorName(task.id);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
    };
    const initialEvent: KernelEvent = {
      schemaVersion: 2,
      type: 'timer_tick',
      id: `timer_event_${input.blockedDecisionId}_${input.occurredAt}`,
      correlationId: input.blockedDecisionId,
      causationId: input.blockedDecisionId,
      occurredAt: input.occurredAt,
      sessionId: this.deps.sessionId,
      taskId: task.id,
      subtaskId: subtask.id,
      wakeKind: 'capacity',
      sourceDecisionId: input.blockedDecisionId,
      scheduledFor: input.occurredAt,
      retry: null,
    };
    const workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot: event => event.type === 'plan_proposed'
        ? this.deps.callbacks.buildPlanAdmissionSnapshot(event)
        : event.type === 'timer_tick' ? {
            schemaVersion: 2,
            type: 'timer',
            capacityBlockedAt: input.blockedAt,
            recheckAfterMs: input.recheckAfterMs,
            capacityAgentClasses: subtask.preferredAgentClassList,
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
            executorStatuses: stableFacts.executorStatuses,
          }
        : this.buildDispatchSnapshot(task.id, attemptedAgentClasses, 'ready', stableFacts),
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type !== 'no_op') applied = true;
          return this.applyExecutionDecision({
            decision,
            executionId,
            request,
            progressTracker,
            attemptedAgentClasses,
            correctionInputs,
            attemptFacts: [],
            finishExecution,
          });
        },
      },
    });
    await workflow.submit(initialEvent);
    return applied;
  }

  private async blockTask(
    taskId: string,
    reason: string,
    finishExecution: (lines: string[], scheduleNext?: boolean) => Promise<void>,
  ): Promise<void> {
    if (this.deps.taskRuntimeService.findTask(taskId)?.status === 'running') {
      this.deps.taskRuntimeService.blockTask(taskId, {
        taskId,
        type: 'manual',
        description: reason,
        status: 'waiting',
      });
    }
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
    if (this.deps.taskRuntimeService.findTask(input.taskId)?.status === 'running') {
      this.deps.taskRuntimeService.transitionTask(input.taskId, 'done');
    }
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
    if (outcome.outcome !== 'completed' && outcome.outcome !== 'executor_failed') return;
    const succeeded = outcome.outcome === 'completed';
    this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
      agentClassName,
      outcome: succeeded ? 'succeeded' : 'failed',
      failure: succeeded ? null : outcome.outcome === 'executor_failed' ? outcome.failure : null,
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
