// Execution application service: Session supplies facade callbacks but owns no runtime policy.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OrchestrationEngine } from '../guidance/orchestration.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { ExecutionProgressService } from '../execution/execution-progress-service.js';
import type { SessionPersistenceService } from '../session/session-persistence-service.js';
import type { ConversationResultDelivery } from '../session/conversation-session.js';
import type { GuidanceProposal, Subtask, Suggestion } from '../core/types.js';
import type { NotificationService } from '../notifications/types.js';
import { generateInteractionId } from '../utils/id.js';
import type { QueuedExecutionRequest } from '../session/session-helpers.js';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../core/authorized-executor-binding.js';
import type { SessionPresentationService, GuidanceState } from '../session/session-presentation-service.js';
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
import { deriveRecoverySafety } from '../routing/types.js';
import type { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import type {
  ExecutorAttemptReceipt,
  ExecutorAttemptReceiptRepo,
} from '../storage/executor-attempt-receipt-repo.js';
import { buildDefaultResourceClaims } from '../resource/index.js';
import { deriveRunnableFrontier } from '../work-graph/index.js';
import type { KernelDispatchItemRepo, KernelDispatchItemRecord } from '../storage/kernel-dispatch-item-repo.js';
import type { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import type { ResultObjectRepo } from '../storage/result-object-repo.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import type { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import type { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';
import { AttemptSupervisor, type AttemptSupervisorContext } from './attempt-supervisor.js';
import type {
  CancellationReceipt,
  TaskCancellationCoordinator,
} from './task-cancellation-coordinator.js';
import type {
  WorkspacePublicationWorker,
  WorkspacePublicationOutcome,
} from './workspace-publication-worker.js';
import type { HistoricalResultUpgrader } from './historical-result-upgrader.js';
import { formatExecutorProgress, normalizeExecutorFailure } from '../executor/error-utils.js';
import type { ExecutorAdapter, ExecutorProgressEvent } from '../executor/adapter.js';
import type { ExecutionTraceAppendInput } from './execution-trace.js';
import {
  buildExecutorDisplayFacts,
  executionEventDetails,
} from './execution-transparency.js';
import {
  resolvePublicRoutingIdentity,
  type RuntimeConfigurationView,
} from '../configuration/index.js';
import {
  isSupersededMergeReplanApplication,
  isRetrySafeLegacySystemBindingReplan,
  isRetrySafeMergeRepairReplan,
  legacySystemBindingRecoveryEvent,
  mergeReplanAssumeAppliedRecoveryEvent,
  mergeRepairReplanRecoveryEvent,
} from './kernel-application-recovery.js';
import { mergeConflictObservationId } from './merge-repair-protocol.js';
import { describeAttemptFailure } from './failure-reasons.js';

interface FocusContext {
  kind: 'conversation' | 'task';
  taskId: string | null;
}

interface DispatchStableFacts {
  executorStatuses: Extract<KernelSnapshot, { type: 'dispatch' }>['executorStatuses'];
  correctionSupportedAgentClasses: string[];
  nativeContinuationAgentClasses: string[];
}

const DEFAULT_EXECUTION_TRACE_HEARTBEAT_MS = 10_000;

function defaultResourceGrant(taskId: string, generationId: string, subtaskId: string) {
  return buildDefaultResourceClaims({
    workspaceId: `workspace-${taskId}-${generationId}-${subtaskId}`,
    sourceMountId: `source-${taskId}`,
    inputsMountId: `inputs-${taskId}`,
    handoffsMountId: `handoffs-${taskId}-${generationId}`,
    gitMetadataMountId: `git-metadata-${taskId}-${generationId}-${subtaskId}`,
  });
}

function dependencyReadinessFacts(input: {
  taskId: string;
  generationId: string;
  subtasks: readonly Subtask[];
  handoffs: readonly import('../storage/subtask-handoff-repo.js').PersistedSubtaskHandoff[];
  resultObjectRepo?: ResultObjectRepo;
  workspaceRepository?: WorkspaceRepositoryPort;
}): Extract<KernelSnapshot, { type: 'dispatch' }>['dependencyReadiness'] {
  const byId = new Map(input.subtasks.map(subtask => [subtask.id, subtask]));
  const handoffByEdge = new Map(
    input.handoffs.map(handoff => [
      `${handoff.fromSubtaskId}\u0000${handoff.toSubtaskId}`,
      handoff,
    ]),
  );
  const facts: NonNullable<Extract<KernelSnapshot, { type: 'dispatch' }>['dependencyReadiness']> = [];

  for (const target of input.subtasks) {
    for (const dependency of target.dependencies) {
      const source = byId.get(dependency.fromSubtaskId);
      if (!source) {
        facts.push({
          sourceSubtaskId: dependency.fromSubtaskId,
          targetSubtaskId: target.id,
          code: 'identity_mismatch',
          terminal: true,
          detail: 'dependency source Subtask is not present in the active graph',
        });
        continue;
      }
      if (source.status !== 'done') {
        facts.push({
          sourceSubtaskId: source.id,
          targetSubtaskId: target.id,
          code: 'pending_publication',
          terminal: false,
          detail: `source Subtask status is ${source.status}`,
        });
        continue;
      }
      const handoff = handoffByEdge.get(`${source.id}\u0000${target.id}`);
      if (!handoff) {
        facts.push({
          sourceSubtaskId: source.id,
          targetSubtaskId: target.id,
          code: 'missing_handoff',
          terminal: true,
          detail: 'source is done but the edge-scoped handoff is missing',
        });
        continue;
      }
      const resultReference = handoff.resultReference;
      const referenceItem = handoff.items.find(item => item.type === 'result_reference');
      if (referenceItem) {
        if (
          !resultReference
          || resultReference.referenceId !== referenceItem.referenceId
          || resultReference.taskId !== input.taskId
          || resultReference.generationId !== input.generationId
          || resultReference.sourceSubtaskId !== source.id
          || resultReference.targetSubtaskId !== target.id
        ) {
          facts.push({
            sourceSubtaskId: source.id,
            targetSubtaskId: target.id,
            code: 'identity_mismatch',
            terminal: true,
            detail: `Result Reference identity does not match ${source.id} -> ${target.id}`,
          });
          continue;
        }
        if (input.resultObjectRepo && !input.resultObjectRepo.findObject(resultReference.resultId)) {
          facts.push({
            sourceSubtaskId: source.id,
            targetSubtaskId: target.id,
            code: 'missing_result_object',
            terminal: true,
            detail: `Result Object ${resultReference.resultId} is missing`,
          });
          continue;
        }
        const persistedReference = input.resultObjectRepo?.findReference(resultReference.referenceId);
        if (
          input.resultObjectRepo
          && (!persistedReference || persistedReference.targetSubtaskId !== target.id)
        ) {
          facts.push({
            sourceSubtaskId: source.id,
            targetSubtaskId: target.id,
            code: 'identity_mismatch',
            terminal: true,
            detail: `Result Reference ${resultReference.referenceId} is not authorized for target ${target.id}`,
          });
          continue;
        }
      }
      if (
        input.workspaceRepository
        && !input.workspaceRepository.findByIdentity(input.taskId, input.generationId, source.id)
      ) {
        facts.push({
          sourceSubtaskId: source.id,
          targetSubtaskId: target.id,
          code: 'missing_workspace',
          terminal: true,
          detail: `source workspace state is missing for ${source.id}`,
        });
      }
    }
  }
  return facts.length > 0 ? facts : undefined;
}

function resumeRecoveryCandidates(input: {
  configurationRevision: string;
  subtasks: readonly Subtask[];
  receipts: readonly ExecutorAttemptReceipt[];
  dispatchItems: readonly KernelDispatchItemRecord[];
  workspaceRepository: WorkspaceRepositoryPort;
  nativeContinuationAgentClasses: readonly string[];
}): Extract<KernelSnapshot, { type: 'dispatch' }>['resumeRecoveryCandidates'] {
  const activeSubtaskIds = new Set(input.dispatchItems
    .filter(item => ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status))
    .map(item => item.subtaskId));
  const latestReceiptBySubtask = new Map<string, ExecutorAttemptReceipt>();
  for (const receipt of input.receipts) {
    if (!latestReceiptBySubtask.has(receipt.subtaskId)) {
      latestReceiptBySubtask.set(receipt.subtaskId, receipt);
    }
  }
  const candidates = input.subtasks.flatMap(subtask => {
    if (
      !['awaiting_decision', 'blocked'].includes(subtask.status)
      || activeSubtaskIds.has(subtask.id)
    ) return [];
    const receipt = latestReceiptBySubtask.get(subtask.id);
    if (
      !receipt
      || receipt.terminalState !== 'uncertified_result'
      || receipt.failure !== null
      || receipt.configurationRevision !== input.configurationRevision
      || receipt.bindingFingerprint !== authorizedExecutorBindingFingerprint(
        receipt.authorizedBinding,
      )
      || !subtask.executorBindings.some(binding =>
        authorizedExecutorBindingFingerprint(binding) === receipt.bindingFingerprint
      )
      || receipt.verification.violations.length !== 1
    ) return [];
    const violation = receipt.verification.violations[0]!;
    const recoveryReason = violation.code === 'completion_malformed' && violation.path === 'marker'
      ? 'completion_marker_missing' as const
      : violation.code === 'completion_no_change_reason_mismatch'
        && violation.path === 'noChangeReason'
        ? 'completion_no_change_reason_mismatch' as const
        : violation.code === 'completion_malformed' && violation.path === 'report'
          ? 'completion_metadata_invalid' as const
        : null;
    if (!recoveryReason) return [];
    const metadataCorrection = recoveryReason === 'completion_metadata_invalid';
    if (
      !metadataCorrection
      && deriveRecoverySafety(subtask.requiredCapabilities) === 'external_non_idempotent'
    ) return [];
    const workspace = input.workspaceRepository.findByIdentity(
      receipt.taskId,
      receipt.generationId,
      receipt.subtaskId,
    );
    if (!workspace || workspace.status !== 'active') return [];
    try {
      if (!workspace.rootUri.startsWith('file:') || !existsSync(fileURLToPath(workspace.rootUri))) {
        return [];
      }
    } catch {
      return [];
    }
    return [{
      subtaskId: subtask.id,
      sourceAttemptId: receipt.attemptId,
      authorizedBinding: receipt.authorizedBinding,
      bindingFingerprint: receipt.bindingFingerprint,
      recoveryMode: input.nativeContinuationAgentClasses.includes(
        receipt.authorizedBinding.agentClassRef,
      ) ? 'native_session' as const : 'recovery_packet' as const,
      reason: recoveryReason,
      ...(metadataCorrection ? {
        attemptKind: 'contract_correction' as const,
        attemptPayload: {
          protocol: 'completion-correction-v2' as const,
          completionContract: receipt.parsing.completionContract ?? {},
          violations: receipt.verification.violations,
        },
      } : {}),
    }];
  });
  return candidates.length > 0 ? candidates : undefined;
}

export function classifyResumeBlocker(
  reason: string | undefined,
  latestFailure?: import('../core/kernel-failure.js').KernelFailure | null,
): import('../kernel/control-kernel.js').KernelResumeBlockerCategory {
  const normalized = reason?.toLowerCase() ?? '';
  // 启动恢复对“活跃但无 authorized dispatch”的 Subtask 只做 fail-closed 手动阻塞；
  // 描述里的 "authorized" 指 dispatch 授权，而不是缺材料/权限，不能归为 explicit_resource。
  if (normalized.includes('without authorized dispatch')) return 'manual';
  if (
    latestFailure?.kind === 'unknown'
    && normalizeExecutorFailure(latestFailure.summary).kind === 'network'
  ) return 'retry';
  if (normalized.includes('capacity') || normalized.includes('资源')) return 'capacity';
  if (
    normalized.includes('retry')
    || normalized.includes('重试')
    || normalized.includes('network')
    || normalized.includes('网络')
    || normalized.includes('代理')
    || normalized.includes('连接')
    || normalized.includes('timeout')
    || normalized.includes('超时')
  ) return 'retry';
  if (normalized.includes('availability') || normalized.includes('可用')) return 'availability';
  if (normalized.includes('publication') || normalized.includes('handoff') || normalized.includes('依赖')) {
    return 'dependency_publication';
  }
  if (
    normalized.includes('explicit resource')
    || normalized.includes('explicit_resource')
    || normalized.includes('material')
    || normalized.includes('材料')
    || normalized.includes('文件')
    || normalized.includes('证据')
    || normalized.includes('资源')
    || normalized.includes('权限')
    || normalized.includes('授权')
    || normalized.includes('目录')
    || normalized.includes('permission')
    || normalized.includes('authorized')
    || normalized.includes('access')
    || normalized.includes('evidence')
  ) return 'explicit_resource';
  if (normalized.includes('contract') || normalized.includes('契约')) return 'contract';
  return 'unknown';
}

export interface KernelExecutionRuntimeInput {
  taskId: string;
  request: QueuedExecutionRequest;
  recoveryOnly?: boolean;
  /** Application-Shell acknowledgement for the first authoritative execution decision. */
  onInitialDecision?(decision: KernelDecision): void;
}

export interface PreparedKernelExecutionInput extends KernelExecutionRuntimeInput {
  graphState: 'ready' | 'missing' | 'conflict';
}

export interface KernelExecutionRuntimeDeps {
  sessionId: string;
  getSessionId?(): string;
  getConfigurationRevision(): string;
  getRuntimeConfiguration?: (revisionId: string) => RuntimeConfigurationView | null;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  /** Resolves a task's conversation workspace path when the queued request
   *  does not carry one (timer/recovery requests historically omitted it,
   *  which broke continuation dispatches with a missing workspace source). */
  resolveWorkspacePath?: (taskId: string) => Promise<string | null>;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  subtaskRepo: SubtaskRepo;
  workGraphRevisionRepo: WorkGraphRevisionRepo;
  effectOutboxRepo: KernelEffectOutboxRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  historicalResultUpgrader?: Pick<HistoricalResultUpgrader, 'upgrade'>;
  subtaskHandoffRepo: SubtaskHandoffRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  attemptRunner: SubtaskAttemptRunner;
  controlKernel: ControlKernel;
  kernelWorkflowStore: KernelWorkflowStore & {
    listCapacitySignals?(
      taskId: string,
      cycleId: string,
    ): Array<Extract<KernelEvent, { type: 'capacity_signal' }>>;
    listRecoveryItems?(taskId: string): import('../kernel/kernel-workflow.js').KernelDecisionApplicationRecord[];
    findRecoveryItem?(id: string): import('../kernel/kernel-workflow.js').KernelDecisionApplicationRecord | null;
    resolveRecoveryItem?(
      id: string,
      resolution: 'assume_applied' | 'retry',
      now: string,
    ): void;
  };
  kernelDecisionRepo?: Pick<KernelDecisionRepo, 'findById'>;
  dispatchItemRepo: KernelDispatchItemRepo;
  maxConcurrentAttempts: number;
  maxConcurrentAttemptsPerTask?: number;
  conversationTaskSchedulerRepo?: ConversationTaskSchedulerRepo;
  onTaskTerminal?(taskId: string): void | Promise<void>;
  executionTraceHeartbeatMs?: number;
  publicationWorker: WorkspacePublicationWorker;
  publicationRepo: WorkspacePublicationRepo;
  resultObjectRepo: ResultObjectRepo;
  workspaceRepository: WorkspaceRepositoryPort;
  generationReplanRepo: GenerationReplanRequestRepo;
  cancellationCoordinator: TaskCancellationCoordinator;
  executionProgressService: ExecutionProgressService;
  verificationAndDeliveryService: VerificationAndDeliveryService;
  persistenceService: SessionPersistenceService;
  kernelExecutorStatusProjector: KernelExecutorStatusProjector;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    recordResultDelivery(delivery: ConversationResultDelivery): void;
    appendExecutionTrace(input: ExecutionTraceAppendInput): void;
    refreshRuntimeState(): void;
    appendTaskQueueSnapshot(trigger: string): void;
    setFocusContext(focus: FocusContext | null): void;
    setRunningExecutorName(taskId: string, subtaskId: string, attemptId: string, name: string): void;
    clearRunningExecutorName(taskId: string, attemptId?: string): void;
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
    requestMergeReplan(decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
    }): Promise<KernelEvent | null>;
    buildPlanAdmissionSnapshot(event: Extract<KernelEvent, { type: 'plan_proposed' }>): KernelSnapshot;
  };
}

/** Runtime handler set for Kernel decisions. It applies one authorized action and reports one fact. */
export class KernelExecutionRuntime {
  private readonly taskEvents: TaskEventRecorder;
  private readonly attemptSupervisor: AttemptSupervisor;
  private readonly cancellationRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cancellationDrains = new Map<string, Promise<void>>();
  private readonly decisionSession = new AsyncLocalStorage<string>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: KernelExecutionRuntimeDeps) {
    this.taskEvents = new TaskEventRecorder(deps.taskEventRepo);
    this.attemptSupervisor = new AttemptSupervisor(
      deps.dispatchItemRepo,
      deps.maxConcurrentAttempts,
      deps.maxConcurrentAttemptsPerTask ?? deps.maxConcurrentAttempts,
    );
  }

  private get sessionId(): string {
    return this.decisionSession.getStore()
      ?? this.deps.getSessionId?.()
      ?? this.deps.sessionId;
  }

  private appendExecutionTrace(input: ExecutionTraceAppendInput): void {
    // Observability must never turn a successful authorized attempt into an
    // Executor failure if a client has disconnected or a presentation adapter
    // rejects an update.
    try {
      this.deps.callbacks.appendExecutionTrace(input);
    } catch {
      // The durable execution path remains authoritative.
    }
  }

  private withDecisionSession<T>(
    decision: KernelDecision,
    operation: () => Promise<T>,
  ): Promise<T> {
    const sessionId = this.deps.kernelDecisionRepo?.findById(decision.id)?.sessionId;
    return sessionId
      ? this.decisionSession.run(sessionId, operation)
      : operation();
  }

  async cancelTask(taskId: string, reason = 'explicit Task cancellation command'): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      configurationRevision: this.configurationRevisionForTask(taskId),
      type: 'task_cancel_requested',
      id: `task_cancel_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
      taskId,
      reason,
    });
  }

  async cancelSubtasks(
    taskId: string,
    targetSubtaskIds: string[],
    reason = 'explicit Subtask cancellation command',
  ): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      configurationRevision: this.configurationRevisionForTask(taskId),
      type: 'subtasks_cancel_requested',
      id: `subtasks_cancel_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
      taskId,
      targetSubtaskIds,
      reason,
    });
  }

  async acceptPartialResult(taskId: string): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      configurationRevision: this.configurationRevisionForTask(taskId),
      type: 'partial_result_acceptance_requested',
      id: `partial_accept_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
      taskId,
    });
  }

  async recoverCancellations(taskId?: string): Promise<void> {
    await this.trackCancellationDrain(
      taskId ? `recover:${taskId}` : 'recover:all',
      () => this.deps.cancellationCoordinator.recover(taskId),
    );
  }

  async executorRecovered(
    agentClassName: string,
    configurationRevision: string,
    recoveryCheckId: string,
  ): Promise<void> {
    for (const request of this.deps.generationReplanRepo.listWaitingForAvailability()) {
      if (request.configurationRevision !== configurationRevision) continue;
      const task = this.deps.taskRuntimeService.findTask(request.taskId);
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(request.taskId);
      const event: Extract<KernelEvent, { type: 'executor_recovered' }> = {
        schemaVersion: 5,
        configurationRevision: request.configurationRevision,
        type: 'executor_recovered',
        id: `executor_recovered_${recoveryCheckId}_${request.id}`,
        correlationId: request.id,
        causationId: recoveryCheckId,
        occurredAt: new Date().toISOString(),
        sessionId: this.sessionId,
        taskId: request.taskId,
        agentClassName,
        recoveryCheckId,
      };
      const workflow = new DurableKernelWorkflow({
        kernel: this.deps.controlKernel,
        buildSnapshot: () => ({
          schemaVersion: 5,
          type: 'availability_recovery',
          task: task ? { id: task.id, status: task.status } : null,
          activeGenerationId: activeRevision?.generationId ?? null,
          activeGraphRevision: activeRevision?.revision ?? null,
          deferredPlan: request.deferredPlan,
          deferredBindings: request.deferredBindings,
          executorStatuses: this.deps.kernelExecutorStatusProjector.list(
            request.configurationRevision,
          ),
        }),
        store: this.deps.kernelWorkflowStore,
        clock: { now: () => new Date().toISOString() },
        runtime: {
          apply: async decision => {
            if (decision.action.type === 'no_op') return null;
            if (decision.action.type !== 'activate_deferred_task_plan') {
              throw new Error(`Availability recovery Runtime cannot apply ${decision.action.type}`);
            }
            const currentRequest = this.deps.generationReplanRepo.find(decision.action.replanRequestId);
            const currentTask = this.deps.taskRuntimeService.findTask(decision.action.taskId);
            if (currentRequest?.status !== 'waiting_for_availability' || currentTask?.status !== 'blocked') {
              return null;
            }
            const result = this.deps.workGraphRuntimeService.apply({
              task: currentTask,
              userPrompt: currentRequest.deferredPlan?.requestText ?? currentTask.goal,
              sessionId: this.sessionId,
              authorizedWorkGraph: decision.action.workGraph,
              authorizedBindingsBySubtask: decision.action.authorizedBindingsBySubtask,
              authorization: {
                decisionId: decision.id,
                generationId: decision.action.generationId,
                revision: decision.action.graphRevision,
                source: decision.action.proposalSource,
                automaticReplan: true,
              },
            });
            if (result.outcome === 'not_executable') return null;
            this.deps.generationReplanRepo.resolve(currentRequest.id, new Date().toISOString());
            this.deps.taskRuntimeService.unblockTask(currentTask.id);
            this.deps.callbacks.refreshRuntimeState();
            return null;
          },
        },
        acceptedEventTypes: ['executor_recovered'],
        acceptedActions: ['activate_deferred_task_plan', 'no_op'],
        taskId: request.taskId,
      });
      await workflow.submit(event);
    }
  }

  getSingleActiveTaskId(): string | null {
    return this.deps.taskRuntimeService.getCurrentRunningTask()?.id
      ?? this.deps.cancellationCoordinator.findCleanupTaskId();
  }

  private async submitTaskControlEvent(
    event: Extract<KernelEvent, {
      type: 'task_cancel_requested' | 'subtasks_cancel_requested'
        | 'partial_result_acceptance_requested';
    }>,
  ): Promise<CancellationReceipt> {
    let receipt: CancellationReceipt | null = null;
    let controlError: string | null = null;
    const workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot: () => this.deps.cancellationCoordinator.buildSnapshot(event.taskId!),
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: async decision => {
          if (decision.action.type === 'cancel_task' || decision.action.type === 'cancel_subtasks') {
            receipt = this.deps.cancellationCoordinator.apply(
              decision as Parameters<TaskCancellationCoordinator['apply']>[0],
            );
            void this.startCancellationDrain(event.taskId!);
            return null;
          }
          if (decision.action.type === 'accept_partial_result') {
            const action = decision.action;
            const revision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
            const blocked = this.deps.cancellationCoordinator.completionBlockedReasons(
              action.taskId,
              action.generationId,
              decision.id,
            );
            if (
              !revision
              || revision.generationId !== action.generationId
              || revision.revision !== action.graphRevision
              || blocked.length > 0
            ) {
              controlError = `partial acceptance changed before application${blocked.length > 0
                ? `: ${blocked.join(', ')}`
                : ''}`;
              return null;
            }
            const allSubtasks = this.deps.subtaskRepo.listActiveByTask(action.taskId);
            const done = allSubtasks.filter(subtask =>
              action.completedSubtaskIds.includes(subtask.id) && subtask.status === 'done'
            );
            const cancelled = allSubtasks.filter(subtask =>
              action.cancelledSubtaskIds.includes(subtask.id) && subtask.status === 'cancelled'
            );
            if (
              done.length !== action.completedSubtaskIds.length
              || cancelled.length !== action.cancelledSubtaskIds.length
            ) {
              controlError = 'partial acceptance Subtask facts changed before application';
              return null;
            }
            const task = this.deps.taskRuntimeService.findTask(action.taskId)!;
            await this.completeTask({
              taskId: action.taskId,
              decisionId: decision.id,
              executionId: `partial_${decision.id}`,
              request: {
                userPrompt: task.goal,
                contextTaskId: task.id,
                executionMode: 'follow-up',
                origin: 'user',
                schedulingReason: 'explicit partial result acceptance',
              },
              subtasks: done,
              cancelledSubtasks: cancelled,
              completionKind: 'partial_accepted',
              revisionCompletion: {
                revision: action.graphRevision,
                completionKind: 'partial_accepted',
              },
              finishExecution: async lines => {
                this.deps.callbacks.appendOutput(...lines);
                this.deps.callbacks.refreshRuntimeState();
              },
            });
            receipt = {
              taskId: action.taskId,
              affectedSubtaskIds: action.cancelledSubtaskIds,
              cleanupAttemptIds: [],
            };
            return null;
          }
          if (decision.action.type === 'reject_request' || decision.action.type === 'block_work') {
            controlError = decision.reason;
            return null;
          }
          if (decision.action.type === 'no_op') return null;
          throw new Error(`Task control Runtime cannot apply ${decision.action.type}`);
        },
      },
      acceptedEventTypes: [
        'task_cancel_requested',
        'subtasks_cancel_requested',
        'partial_result_acceptance_requested',
      ],
      acceptedActions: [
        'cancel_task',
        'cancel_subtasks',
        'accept_partial_result',
        'reject_request',
        'block_work',
        'no_op',
      ],
      taskId: event.taskId!,
    });
    await workflow.submit(event);
    if (controlError) throw new Error(controlError);
    if (!receipt) throw new Error('Task control decision produced no receipt');
    return receipt;
  }

  private async drainCancellation(taskId: string): Promise<void> {
    try {
      await this.attemptSupervisor.drain(taskId);
      await this.deps.cancellationCoordinator.recover(taskId);
      const task = this.deps.taskRuntimeService.findTask(taskId);
      if (task?.status === 'cancelled'
        && this.deps.cancellationCoordinator.completionBlockedReasons(taskId, null).length === 0) {
        await this.deps.onTaskTerminal?.(taskId);
      }
      this.deps.callbacks.refreshRuntimeState();
      this.clearCancellationRetry(taskId);
      const remainingTaskIds = this.deps.cancellationCoordinator.listCleanupTaskIds?.()
        ?? [this.deps.cancellationCoordinator.findCleanupTaskId()].filter(
          (taskId): taskId is string => Boolean(taskId),
        );
      for (const remainingTaskId of remainingTaskIds) {
        this.scheduleCancellationRetry(remainingTaskId);
      }
    } catch {
      // Durable cancelling rows retain capacity while the same process and startup
      // recovery both retry cleanup.
      this.scheduleCancellationRetry(taskId);
    }
  }

  private startCancellationDrain(taskId: string): Promise<void> {
    return this.trackCancellationDrain(
      `drain:${taskId}`,
      () => this.drainCancellation(taskId),
    );
  }

  private trackCancellationDrain(
    key: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const active = this.cancellationDrains.get(key);
    if (active) return active;
    const drain = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.cancellationDrains.get(key) === drain) {
          this.cancellationDrains.delete(key);
        }
      });
    this.cancellationDrains.set(key, drain);
    return drain;
  }

  private scheduleCancellationRetry(taskId: string): void {
    if (this.disposed) return;
    if (this.cancellationRetryTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.cancellationRetryTimers.delete(taskId);
      void this.startCancellationDrain(taskId);
    }, 1_000);
    timer.unref?.();
    this.cancellationRetryTimers.set(taskId, timer);
  }

  private clearCancellationRetry(taskId: string): void {
    const timer = this.cancellationRetryTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.cancellationRetryTimers.delete(taskId);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const timer of this.cancellationRetryTimers.values()) clearTimeout(timer);
    this.cancellationRetryTimers.clear();
    this.disposePromise = (async () => {
      while (this.cancellationDrains.size > 0) {
        await Promise.allSettled([...this.cancellationDrains.values()]);
      }
    })();
    return this.disposePromise;
  }

  async recoverDue(taskId: string, reason = 'durable workflow recovery'): Promise<boolean> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) return false;
    const beforeStatus = task.status;
    const beforeUpdatedAt = task.updatedAt;
    await this.execute(this.prepareExecution({
      taskId,
      request: {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: task.status === 'blocked' ? 'resume-blocked' : 'follow-up',
        origin: 'system',
        schedulingReason: reason,
      },
      recoveryOnly: true,
    }));
    const after = this.deps.taskRuntimeService.findTask(taskId);
    return after !== null
      && (after.status !== beforeStatus || after.updatedAt !== beforeUpdatedAt);
  }

  private buildDispatchSnapshot(
    taskId: string,
    graphState: 'ready' | 'missing' | 'conflict' = 'ready',
    stableFacts?: DispatchStableFacts,
    attempts: KernelAttemptFact[] = [],
    recoverySubtaskId: string | null = null,
    capacityProbeBindingFingerprints: Record<string, string[]> = {},
  ): KernelSnapshot {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const subtasks = activeRevision
      ? this.deps.subtaskRepo.listActiveByTask(taskId)
      : this.deps.subtaskRepo.listByTask(taskId);
    const configurationRevision = activeRevision?.configurationRevision
      ?? this.configurationRevisionForTask(taskId);
    const revisionStableFacts = stableFacts
      ?? this.buildDispatchStableFacts(configurationRevision);
    const done = new Set(subtasks.filter(subtask => subtask.status === 'done').map(subtask => subtask.id));
    const persistedHandoffs = this.deps.subtaskHandoffRepo.listByTask(taskId);
    const handoffs = new Set(persistedHandoffs
      .map(handoff => `${handoff.fromSubtaskId}\u0000${handoff.toSubtaskId}`));
    const persistedReceipts = this.deps.attemptReceiptRepo.listByTask(taskId)
      .filter(receipt => !activeRevision || (
        receipt.generationId === activeRevision.generationId
        && receipt.graphRevision === activeRevision.revision
      ));
    const persistedAttempts: KernelAttemptFact[] = persistedReceipts
      .filter(receipt => receipt.terminalState !== 'contract_blocked')
      .map(receipt => ({
        attemptId: receipt.attemptId,
        subtaskId: receipt.subtaskId,
        authorizedBinding: receipt.authorizedBinding,
        bindingFingerprint: receipt.bindingFingerprint,
        attemptKind: receipt.attemptKind,
        sourceAttemptId: receipt.sourceAttemptId,
        terminalKind: receipt.terminalState === 'completed' ? 'completed' : 'failed',
        failure: receipt.failure,
        completedAt: receipt.completedAt,
      }));
    const attemptFacts = [...new Map(
      [...attempts, ...persistedAttempts].map(attempt => [attempt.attemptId, attempt]),
    ).values()];
    const dispatchItems = this.deps.dispatchItemRepo.listByTask(taskId);
    const firstDispatchOrder = new Map<string, number>();
    for (const item of dispatchItems) {
      const current = firstDispatchOrder.get(item.subtaskId);
      if (current === undefined || item.batchOrder < current) {
        firstDispatchOrder.set(item.subtaskId, item.batchOrder);
      }
    }
    const dependencyReadiness = dependencyReadinessFacts({
      taskId,
      generationId: activeRevision?.generationId ?? `generation_${taskId}_1`,
      subtasks,
      handoffs: persistedHandoffs,
      resultObjectRepo: this.deps.resultObjectRepo,
      workspaceRepository: this.deps.workspaceRepository,
    }) ?? [];
    const recoveryCandidates = resumeRecoveryCandidates({
      configurationRevision,
      subtasks,
      receipts: persistedReceipts,
      dispatchItems,
      workspaceRepository: this.deps.workspaceRepository,
      nativeContinuationAgentClasses: revisionStableFacts.nativeContinuationAgentClasses,
    });
    const frontier = deriveRunnableFrontier(
      { subtasks },
      subtasks.map(subtask => ({
        subtaskId: subtask.id,
        status: subtask.status,
        firstDispatchOrder: firstDispatchOrder.get(subtask.id) ?? null,
        hasPendingOrActiveAttempt: dispatchItems.some(item =>
          item.subtaskId === subtask.id
          && ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status)
        ),
      })),
    ).filter(subtaskId => {
      const subtask = subtasks.find(item => item.id === subtaskId);
      return subtask?.dependencies.every(dependency =>
        done.has(dependency.fromSubtaskId)
        && handoffs.has(`${dependency.fromSubtaskId}\u0000${subtask.id}`)
        && dependencyReadiness.every(fact => (
          fact.targetSubtaskId !== subtask.id
          || fact.sourceSubtaskId !== dependency.fromSubtaskId
          || fact.code === 'ready'
        ))
      ) ?? false;
    });
    const recoverySubtask = recoverySubtaskId
      ? subtasks.find(subtask => subtask.id === recoverySubtaskId)
      : subtasks.find(subtask => frontier.includes(subtask.id));
    const recoverySafety = deriveRecoverySafety(recoverySubtask?.requiredCapabilities ?? []);
    return {
      schemaVersion: 5,
      type: 'dispatch',
      task: task ? {
        id: task.id,
        status: task.status,
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
        ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
      } : null,
      activeTaskByConversation: this.deps.conversationTaskSchedulerRepo
        ? Object.fromEntries(this.deps.taskRuntimeService.listTasks().map(candidate => {
            const conversationId = candidate.conversationId ?? 'legacy-conversation';
            return [conversationId, this.deps.conversationTaskSchedulerRepo!.getSlot(conversationId).activeTaskId];
          }))
        : undefined,
      // Kept as a compatibility projection. Kernel policy uses the scoped map.
      runningTaskId: task?.id ?? null,
      graphState,
      subtasks: subtasks.map(subtask => ({
        id: subtask.id,
        taskId: subtask.taskId,
        status: subtask.status,
        executorBindings: subtask.executorBindings,
      })),
      frontier,
      dependencyReadiness,
      resumeRecoveryCandidates: recoveryCandidates,
      dispatchItems: dispatchItems.map(item => ({
        attemptId: item.attemptId,
        subtaskId: item.subtaskId,
        bindingFingerprint: item.bindingFingerprint,
        status: item.status,
        order: item.batchOrder,
      })),
      maxConcurrentAttempts: this.deps.maxConcurrentAttempts,
      availableSlots: Math.max(
        0,
        this.deps.maxConcurrentAttempts - dispatchItems.filter(item =>
          ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status)
        ).length,
      ),
      resourceConflictSubtaskIds: [],
      capacityProbeBindingFingerprints,
      executorStatuses: revisionStableFacts.executorStatuses,
      correctionSupportedAgentClasses: revisionStableFacts.correctionSupportedAgentClasses,
      nativeContinuationAgentClasses: revisionStableFacts.nativeContinuationAgentClasses,
      attempts: attemptFacts,
      generationId: activeRevision?.generationId ?? `generation_${taskId}_1`,
      graphRevision: activeRevision?.revision ?? 1,
      automaticReplansUsed: activeRevision
        ? this.deps.workGraphRevisionRepo.countAutomaticReplans(taskId, activeRevision.generationId)
        : 0,
      recoverySafety,
      automaticRecoveryAllowed: recoverySubtask
        ? recoverySafety !== 'external_non_idempotent'
        : true,
      resourceGrantsBySubtask: Object.fromEntries(subtasks.map(subtask => [
        subtask.id,
        defaultResourceGrant(
          taskId,
          activeRevision?.generationId ?? `generation_${taskId}_1`,
          subtask.id,
        ),
      ])),
      completionBlockedReasons: this.deps.cancellationCoordinator
        .completionBlockedReasons(
          taskId,
          activeRevision?.generationId ?? null,
        ),
      generationReplanRequest: activeRevision
        ? (() => {
            const request = this.deps.generationReplanRepo.findActive(
              taskId,
              activeRevision.generationId,
            );
            return request ? {
              id: request.id,
              status: request.status as 'pending_quiescence' | 'planning' | 'submitted',
            } : null;
          })()
        : null,
      generationQuiescent: frontier.length === 0
        && !dispatchItems.some(item =>
          ['pending_launch', 'launching', 'running', 'cancelling', 'uncertain']
            .includes(item.status)
        )
        && !this.deps.publicationRepo.hasBlockingResidue(
          taskId,
          activeRevision?.generationId,
        )
        && !this.deps.cancellationCoordinator.completionBlockedReasons(
          taskId,
          activeRevision?.generationId ?? null,
        ).some(reason => [
          'execution_backend',
          'work_unit',
          'resource_lease',
          'attempt_receipt',
        ].includes(reason)),
    };
  }

  private buildDispatchStableFacts(configurationRevision: string): DispatchStableFacts {
    const agentClassNames = this.deps.agentClassService.listExecutorAgentClassNames();
    return {
      executorStatuses: this.deps.kernelExecutorStatusProjector.list(configurationRevision),
      correctionSupportedAgentClasses: agentClassNames
        .filter(name => this.deps.attemptRunner.supportsResponseOnly(
          name,
          configurationRevision,
        )),
      nativeContinuationAgentClasses: agentClassNames
        .filter(name => this.deps.attemptRunner.supportsContinuation(
          name,
          configurationRevision,
        )),
    };
  }

  private capacityProbeFacts(
    current: Extract<KernelEvent, { type: 'capacity_signal' }>,
  ): Record<string, string[]> {
    const taskId = current.taskId;
    const subtaskId = current.subtaskId;
    if (!taskId || !subtaskId) return {};
    const signals = this.deps.kernelWorkflowStore.listCapacitySignals?.(
      taskId,
      current.cycleId,
    ) ?? [current];
    const unavailable = new Map<string, Set<string>>();
    for (const signal of signals) {
      if (!signal.subtaskId) continue;
      const classes = unavailable.get(signal.subtaskId) ?? new Set<string>();
      if (signal.available) classes.delete(signal.bindingFingerprint);
      else classes.add(signal.bindingFingerprint);
      unavailable.set(signal.subtaskId, classes);
    }
    return Object.fromEntries(
      [...unavailable].map(([id, classes]) => [id, [...classes].sort()]),
    );
  }

  private retrySafeLegacySystemBindingRecovery(
    taskId: string,
    occurredAt: string,
  ): Extract<KernelEvent, { type: 'recovery_resolution_requested' }> | null {
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(taskId);
    if (!activeRevision) return null;
    for (const application of this.deps.kernelWorkflowStore.listRecoveryItems?.(taskId) ?? []) {
      const action = application.decision.action;
      if (action.type === 'request_merge_replan') {
        const publication = this.deps.publicationRepo.find(action.publicationId);
        if (isSupersededMergeReplanApplication({
          taskId,
          application,
          publication,
          subtask: this.deps.subtaskRepo?.findById(action.subtaskId) ?? null,
        })) {
          const decision = this.deps.kernelDecisionRepo?.findById(application.decisionId);
          if (!decision?.sessionId) return null;
          return mergeReplanAssumeAppliedRecoveryEvent({
            taskId,
            application,
            sessionId: decision.sessionId,
            occurredAt,
          });
        }
        if (!isRetrySafeMergeRepairReplan({
          taskId,
          application,
          publication,
          dispatchItems: this.deps.dispatchItemRepo.listByTask(taskId),
        })) continue;
        const decision = this.deps.kernelDecisionRepo?.findById(application.decisionId);
        if (!decision?.sessionId) return null;
        return mergeRepairReplanRecoveryEvent({
          taskId,
          application,
          sessionId: decision.sessionId,
          occurredAt,
        });
      }
      if (action.type !== 'authorize_task_plan') continue;
      const request = this.deps.generationReplanRepo.findByGeneration(
        taskId,
        action.generationId,
        activeRevision.revision,
      );
      if (!isRetrySafeLegacySystemBindingReplan({
        taskId,
        application,
        activeRevision,
        replanRequest: request,
      })) continue;
      const decision = this.deps.kernelDecisionRepo?.findById(application.decisionId);
      if (!decision?.sessionId) return null;
      return legacySystemBindingRecoveryEvent({
        taskId,
        application,
        sessionId: decision.sessionId,
        occurredAt,
      });
    }
    return null;
  }

  private async applyExecutionDecision(input: {
    decision: KernelDecision;
    executionId: string;
    request: QueuedExecutionRequest;
    progressTracker: ReturnType<ExecutionProgressService['createTracker']>;
    supervisorContext: AttemptSupervisorContext;
    attemptFacts: KernelAttemptFact[];
    finishExecution(lines: string[], scheduleNext?: boolean): Promise<void>;
  }): Promise<KernelEvent | null> {
    const { decision } = input;
    const action = decision.action;
    this.appendExecutionTrace({
      phase: 'authorization',
      actor: 'kernel',
      kind: 'kernel_decision_applied',
      status: 'completed',
      title: `Kernel applied ${action.type}`,
      summary: decision.reason,
      details: {
        decisionId: decision.id,
        action: action.type,
        eventId: decision.eventId,
        configurationRevision: decision.configurationRevision,
      },
      eventKey: `${decision.id}:applied`,
      taskId: 'taskId' in action ? action.taskId : null,
    });
    if (action.type === 'resolve_recovery') {
      const application = this.deps.kernelWorkflowStore.findRecoveryItem?.(
        action.recoveryItemId,
      );
      if (!application) return null;
      this.deps.kernelWorkflowStore.resolveRecoveryItem?.(
        action.recoveryItemId,
        action.resolution,
        new Date().toISOString(),
      );
      if (
        action.resolution === 'assume_applied'
        && application.decision.action.type === 'request_merge_replan'
      ) {
        const publication = this.deps.publicationRepo.find(
          application.decision.action.publicationId,
        );
        const subtask = this.deps.subtaskRepo.findById(
          application.decision.action.subtaskId,
        );
        if (publication?.status === 'integrated' && subtask?.status === 'done') {
          return this.eventFromDecision(decision, {
            type: 'dispatch_requested',
            taskId: action.taskId,
            reason: 'superseded merge replan recovery released task completion',
          });
        }
      }
      return null;
    }
    if (action.type === 'resume_task') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (
        !task
        || (
          !['blocked', 'parked'].includes(task.status)
          && !(task.status === 'running' && action.recovery)
        )
      ) return null;
      for (const subtaskId of action.subtaskIds) {
        const subtask = this.deps.subtaskRepo.findById(subtaskId);
        if (
          !subtask
          || subtask.taskId !== action.taskId
          || subtask.status === 'done'
          || subtask.status === 'cancelled'
        ) continue;
        if (subtask.status === 'blocked') {
          this.deps.subtaskRepo.updateStatus(subtask.id, 'ready', { error: null });
        }
      }
      if (task.status === 'parked') this.deps.taskRuntimeService.resumeParkedTask(task.id);
      else if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
      const current = this.deps.taskRuntimeService.findTask(task.id);
      if (current?.status === 'ready') this.deps.taskRuntimeService.transitionTask(task.id, 'running');
      this.deps.callbacks.refreshRuntimeState();
      if (action.recovery) {
        const recoverySubtask = this.deps.subtaskRepo.findById(action.recovery.subtaskId);
        if (
          action.recovery.attemptKind === 'contract_correction'
          && recoverySubtask?.status === 'blocked'
        ) {
          this.deps.subtaskRepo.updateStatus(
            recoverySubtask.id,
            'awaiting_decision',
            { error: 'metadata-only completion correction authorized' },
          );
        }
        return this.eventFromDecision(decision, {
          type: 'dispatch_requested',
          taskId: action.taskId,
          subtaskId: action.recovery.subtaskId,
          reason: `Kernel-authorized recovery of ${action.recovery.sourceAttemptId}`,
          recovery: {
            authorizedBinding: action.recovery.authorizedBinding,
            bindingFingerprint: action.recovery.bindingFingerprint,
            attemptKind: action.recovery.attemptKind,
            sourceAttemptId: action.recovery.sourceAttemptId,
            recoveryMode: action.recovery.recoveryMode,
            defaultResourceGrant: action.recovery.defaultResourceGrant,
            ...(action.recovery.attemptPayload
              ? { attemptPayload: action.recovery.attemptPayload }
              : {}),
          },
        });
      }
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested',
        taskId: action.taskId,
        reason: `Kernel-authorized resume after ${action.blockerCategory} blocker`,
      });
    }
    if (action.type === 'dispatch_batch') {
      const generationId = this.deps.workGraphRevisionRepo.findActive(action.taskId)?.generationId
        ?? `generation_${action.taskId}_1`;
      for (const item of action.items) {
        if (item.attemptKind !== 'merge_repair') continue;
        const subtask = this.deps.subtaskRepo.findById(item.subtaskId);
        if (subtask?.taskId === action.taskId && subtask.status === 'blocked') {
          this.deps.subtaskRepo.updateStatus(
            subtask.id,
            'awaiting_decision',
            { error: 'recovering legacy blocked merge conflict' },
          );
        }
      }
      const attempts = Object.fromEntries(action.items.map(item => [
        item.attemptId,
        {
          authorizedBinding: item.authorizedBinding,
          bindingFingerprint: item.bindingFingerprint,
        },
      ]));
      this.attemptSupervisor.enqueue(
        decision as KernelDecision & {
          action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
        },
        {
          generationId,
          configurationRevision: decision.configurationRevision,
          attempts,
        },
        input.supervisorContext,
        new Date().toISOString(),
      );
      this.appendExecutionTrace({
        phase: 'routing',
        actor: 'kernel',
        kind: 'executor_dispatch_authorized',
        status: 'completed',
        title: 'Kernel authorized Executor dispatch',
        summary: `Kernel authorized ${action.items.length} Executor attempt(s).`,
        details: {
          decisionId: decision.id,
          taskId: action.taskId,
          attemptCount: action.items.length,
          executors: action.items.map(item => ({
            subtaskId: item.subtaskId,
            attemptId: item.attemptId,
            executorName: item.authorizedBinding.agentClassRef,
          })),
        },
        eventKey: `${decision.id}:dispatch`,
        taskId: action.taskId,
      });
      return null;
    }
    if (action.type === 'probe_capacity') {
      const available = await this.deps.workUnitClaimService.probe(
        action.authorizedBinding,
      );
      return this.eventFromDecision(decision, {
        type: 'capacity_signal', taskId: action.taskId, subtaskId: action.subtaskId,
        authorizedBinding: action.authorizedBinding,
        bindingFingerprint: action.bindingFingerprint,
        available,
        cycleId: input.executionId,
        attemptKind: 'primary',
        attemptPayload: null,
      });
    }
    if (action.type === 'wait_for_capacity') {
      await this.blockTask(
        action.taskId, `capacity unavailable for Subtask ${action.subtaskId}`,
        input.finishExecution, 'kernel_capacity',
      );
      return null;
    }
    if (action.type === 'wait_for_retry') {
      await this.blockTask(
        action.taskId, `retry scheduled for ${action.resumeAt}`,
        input.finishExecution, 'kernel_retry',
      );
      return this.eventFromDecision(decision, {
        type: 'timer_tick',
        taskId: action.taskId,
        subtaskId: action.subtaskId,
        occurredAt: action.resumeAt,
        wakeKind: 'retry',
        sourceDecisionId: decision.id,
        scheduledFor: action.resumeAt,
        retry: {
          authorizedBinding: action.authorizedBinding,
          bindingFingerprint: action.bindingFingerprint,
          sourceAttemptId: action.sourceAttemptId,
        },
      });
    }
    if (action.type === 'wait_for_partition') {
      await this.blockTask(
        action.taskId,
        `resource partition is waiting for leases: ${action.conflictingLeaseIds.join(', ')}`,
        input.finishExecution,
        'kernel_capacity',
      );
      return null;
    }
    if (action.type === 'recover_workspace_attempt') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      const subtask = this.deps.subtaskRepo.findById(action.subtaskId);
      if (!task || !subtask) throw new Error('execution-backend recovery target no longer exists');
      if (
        action.lostAttemptId
        && action.authorizedBinding
        && action.bindingFingerprint
        && action.attemptKind
        && action.recoveryMode
        && action.defaultResourceGrant
      ) {
        const lostDispatch = this.deps.dispatchItemRepo.find(action.lostAttemptId);
        if (
          !lostDispatch
          || lostDispatch.taskId !== action.taskId
          || lostDispatch.subtaskId !== action.subtaskId
          || lostDispatch.configurationRevision !== decision.configurationRevision
          || lostDispatch.bindingFingerprint !== action.bindingFingerprint
          || lostDispatch.attemptKind !== action.attemptKind
          || lostDispatch.sourceAttemptId !== (action.sourceAttemptId ?? null)
          || lostDispatch.recoveryMode !== action.recoveryMode
          || JSON.stringify(lostDispatch.authorizedBinding)
            !== JSON.stringify(action.authorizedBinding)
        ) {
          throw new Error(`workspace recovery dispatch identity mismatch: ${action.lostAttemptId}`);
        }
        this.deps.dispatchItemRepo.markTerminal(
          action.lostAttemptId,
          `sandbox lost; replacement authorized by ${decision.id}`,
          new Date().toISOString(),
        );
        const recoveryStatus = action.attemptKind === 'primary'
          ? 'ready'
          : 'awaiting_decision';
        if (subtask.status !== 'done' && subtask.status !== 'cancelled') {
          this.deps.subtaskRepo.updateStatus(subtask.id, recoveryStatus, {
            error: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
          });
        }
        if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
        return this.eventFromDecision(decision, {
          type: 'dispatch_requested',
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          reason: `recover exact attempt binding for workspace ${action.workspaceId}`,
          recovery: {
            authorizedBinding: action.authorizedBinding,
            bindingFingerprint: action.bindingFingerprint,
            attemptKind: action.attemptKind,
            sourceAttemptId: action.sourceAttemptId ?? null,
            recoveryMode: action.recoveryMode,
            defaultResourceGrant: action.defaultResourceGrant,
          },
        });
      }
      if (subtask.status !== 'done' && subtask.status !== 'cancelled') {
        this.deps.subtaskRepo.updateStatus(subtask.id, 'ready', {
          error: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
        });
      }
      if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested', taskId: action.taskId,
        reason: `recover persistent workspace ${action.workspaceId}`,
      });
    }
    if (action.type === 'block_work') {
      if (
        action.subtaskId
        && !action.preserveSubtaskState
        && this.deps.subtaskRepo.findById(action.subtaskId)?.status === 'awaiting_decision'
      ) {
        this.deps.subtaskRepo.updateStatus(action.subtaskId, 'blocked', { error: decision.reason });
      }
      await this.blockTask(action.taskId, decision.reason, input.finishExecution);
      this.appendExecutionTrace({
        phase: 'verification',
        actor: 'kernel',
        kind: 'execution_blocked',
        status: 'blocked',
        title: 'Execution blocked',
        summary: decision.reason,
        details: {
          decisionId: decision.id,
          action: action.type,
          taskId: action.taskId,
          subtaskId: action.subtaskId,
        },
        eventKey: `${decision.id}:blocked`,
        taskId: action.taskId,
        traceStatus: 'blocked',
      });
      return null;
    }
    if (action.type === 'park_for_replan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (task && task.status !== 'parked') this.deps.taskRuntimeService.transitionTask(task.id, 'parked');
      await input.finishExecution([decision.reason]);
      return null;
    }
    if (action.type === 'complete_task') {
      const effectId = `effect_${decision.id}_task_completion`;
      if (
        this.deps.taskRuntimeService.findTask(action.taskId)?.status === 'done'
        && this.deps.effectOutboxRepo.find(effectId)
      ) {
        return null;
      }
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
      const completionBlockedReasons = this.deps.cancellationCoordinator
        .completionBlockedReasons(
          action.taskId,
          activeRevision?.generationId ?? null,
          decision.id,
        );
      if (completionBlockedReasons.length > 0) {
        await this.blockTask(
          action.taskId,
          `Task completion blocked by runtime residue: ${completionBlockedReasons.join(', ')}`,
          input.finishExecution,
          'manual',
        );
        return null;
      }
      const subtasks = this.deps.subtaskRepo.listByTask(action.taskId).filter(subtask =>
        subtask.status === 'done'
        && (!activeRevision || subtask.generationId === activeRevision.generationId)
      );
      await this.completeTask({
        taskId: action.taskId, decisionId: decision.id, executionId: input.executionId, request: input.request, subtasks,
        revisionCompletion: activeRevision ? {
          revision: activeRevision.revision,
          completionKind: 'full',
        } : undefined,
        finishExecution: input.finishExecution,
      });
      return null;
    }
    if (action.type === 'queue_generation_replan') {
      this.deps.generationReplanRepo.enqueue({
        id: action.requestId,
        taskId: action.taskId,
        generationId: action.generationId,
        sourceRevision: action.sourceRevision,
        configurationRevision: decision.configurationRevision,
        triggerDecisionId: decision.id,
        now: new Date().toISOString(),
      });
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested',
        taskId: action.taskId,
        reason: 'generation replan queued; continue independent work until quiescence',
      });
    }
    if (action.type === 'request_replan') {
      const request = this.deps.generationReplanRepo.findByGeneration(
        action.taskId,
        action.generationId,
        action.sourceRevision,
      );
      if (!request) throw new Error('generation replan request is missing');
      const token = `quiescence_${decision.id}`;
      if (!this.deps.generationReplanRepo.markPlanning(
        request.id,
        token,
        new Date().toISOString(),
      )) {
        return null;
      }
      try {
        const event = await this.deps.callbacks.requestReplan(
          decision as KernelDecision & {
            action: Extract<KernelDecision['action'], { type: 'request_replan' }>;
          },
        );
        if (!this.deps.generationReplanRepo.submitPlan(
          request.id,
          token,
          event,
          new Date().toISOString(),
        )) {
          return null;
        }
        return event;
      } catch (error) {
        this.deps.generationReplanRepo.fail(
          request.id,
          error instanceof Error ? error.message : String(error),
          new Date().toISOString(),
        );
        throw error;
      }
    }
    if (action.type === 'request_merge_replan') {
      const now = new Date().toISOString();
      this.deps.publicationRepo.incrementConflictReplan(action.publicationId, now);
      this.deps.publicationRepo.markParkedForConflictReplan(action.publicationId, now);
      return this.deps.callbacks.requestMergeReplan(
        decision as KernelDecision & {
          action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
        },
      );
    }
    if (action.type === 'defer_task_plan_for_availability') {
      const request = this.deps.generationReplanRepo.findByGeneration(
        action.taskId,
        action.proposalEvent.generationId,
        action.proposalEvent.targetGraphRevision - 1,
      );
      if (!request) throw new Error('generation replan request is missing for availability deferral');
      if (!this.deps.generationReplanRepo.deferForAvailability(
        request.id,
        action.proposalEvent,
        action.explanation,
        Object.values(action.authorizedBindingsBySubtask).flat(),
        new Date().toISOString(),
      )) {
        return null;
      }
      await this.blockTask(
        action.taskId,
        action.explanation,
        input.finishExecution,
        'kernel_availability',
      );
      return null;
    }
    if (action.type === 'authorize_task_plan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (!task) throw new Error(`replan Task not found: ${action.taskId}`);
      const result = this.deps.workGraphRuntimeService.apply({
        task,
        userPrompt: input.request.userPrompt,
        sessionId: this.sessionId,
        authorizedWorkGraph: action.workGraph,
        authorizedBindingsBySubtask: action.authorizedBindingsBySubtask,
        authorization: {
          decisionId: decision.id,
          generationId: action.generationId,
          revision: action.graphRevision,
          source: action.proposalSource,
          automaticReplan: action.proposalSource === 'replan',
        },
      });
      if (result.outcome === 'not_executable') throw new Error(`authorized replan could not apply: ${result.reason}`);
      if (action.proposalSource === 'replan') {
        const request = this.deps.generationReplanRepo.findByGeneration(
          action.taskId,
          action.generationId,
          action.graphRevision - 1,
        );
        if (request) this.deps.generationReplanRepo.resolve(request.id, new Date().toISOString());
      }
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
      schemaVersion: 5,
      configurationRevision: decision.configurationRevision,
      id: `event_${decision.id}_${String(event.type)}`,
      correlationId: decision.eventId,
      causationId: decision.id,
      occurredAt: new Date().toISOString(),
      ...this.ownerEnvelopeForTask(
        'taskId' in event && typeof event.taskId === 'string' ? event.taskId : null,
      ),
      ...event,
    } as KernelEvent;
  }

  private async runDispatchItem(input: {
    item: KernelDispatchItemRecord;
    executionId: string;
    request: QueuedExecutionRequest;
    progressTracker: ReturnType<ExecutionProgressService['createTracker']>;
  }): Promise<KernelEvent> {
    const { item } = input;
    let request = input.request;
    if (!request.workspacePath && this.deps.resolveWorkspacePath) {
      // Recovery/timer requests do not carry the conversation workspace;
      // resolve it from the task so continuation attempts execute against
      // the real source instead of the workspace-store fallback (P0-5).
      const resolved = await this.deps.resolveWorkspacePath(item.taskId);
      if (resolved) {
        request = { ...request, workspacePath: resolved };
      }
    }
    const existingReceipt = this.deps.attemptReceiptRepo.findByAttemptId(item.attemptId);
    if (
      existingReceipt?.terminalState === 'contract_blocked'
      && this.deps.historicalResultUpgrader
    ) {
      const upgraded = this.deps.historicalResultUpgrader.upgrade(existingReceipt);
      if (upgraded) {
        this.deps.callbacks.recordResultDelivery(upgraded);
        this.deps.callbacks.appendOutput(
          upgraded.content,
          '',
          '结果已返回，任务完成认证待处理。',
        );
        return this.eventFromDispatchItem(item, {
          type: 'execution_result_observed',
          workUnitId: existingReceipt.workUnitId,
          authorizedBinding: existingReceipt.authorizedBinding,
          bindingFingerprint: existingReceipt.bindingFingerprint,
          contract: existingReceipt.parsing.completionContract ?? {},
          violations: existingReceipt.verification.violations,
          receiptCount: 1,
          responseBytes: Buffer.byteLength(existingReceipt.rawResponse, 'utf8'),
          resultId: upgraded.resultId,
          deliverability: 'deliverable',
          certification: 'uncertified',
          safety: 'safe',
        });
      }
    }
    if (existingReceipt && existingReceipt.terminalState !== 'contract_blocked') {
      this.projectPersistedReceipt(existingReceipt);
      if (existingReceipt.terminalState === 'uncertified_result') {
        const parsing = existingReceipt.parsing as {
          completionContract?: unknown;
          completionAssessment?: {
            deliverability?: { status?: 'deliverable' | 'quarantined' };
            certification?: { status?: 'certified' | 'uncertified' };
            safety?: { status?: 'safe' | 'safety_blocked' };
          } | null;
          responseBytes?: number;
          resultObjects?: { safeProjectionId?: string | null } | null;
        };
        return this.eventFromDispatchItem(item, {
          type: 'execution_result_observed',
          workUnitId: existingReceipt.workUnitId,
          authorizedBinding: existingReceipt.authorizedBinding,
          bindingFingerprint: existingReceipt.bindingFingerprint,
          contract: parsing.completionContract ?? {},
          violations: existingReceipt.verification.violations,
          receiptCount: this.deps.attemptReceiptRepo.countByTerminal(
            existingReceipt.taskId,
            existingReceipt.subtaskId,
            'uncertified_result',
          ),
          responseBytes: parsing.responseBytes ?? 0,
          resultId: parsing.resultObjects?.safeProjectionId ?? null,
          deliverability: parsing.completionAssessment?.deliverability?.status ?? 'deliverable',
          certification: parsing.completionAssessment?.certification?.status ?? 'uncertified',
          safety: parsing.completionAssessment?.safety?.status ?? 'safe',
        });
      }
      return this.eventFromDispatchItem(item, {
        type: 'execution_outcome',
        terminalKind: existingReceipt.terminalState === 'completed' ? 'completed' : 'failed',
        authorizedBinding: existingReceipt.authorizedBinding,
        bindingFingerprint: existingReceipt.bindingFingerprint,
        attemptKind: existingReceipt.attemptKind,
        sourceAttemptId: existingReceipt.sourceAttemptId,
        failure: existingReceipt.terminalState === 'completed'
          ? null
          : existingReceipt.failure ?? {
              kind: existingReceipt.terminalState === 'heartbeat_lost' ? 'heartbeat_lost' : 'unknown',
              scope: 'attempt',
              code: existingReceipt.errorCode ?? 'recovered_attempt_failure',
              summary: existingReceipt.errorDetail ?? 'Recovered terminal attempt receipt',
            },
      });
    }

    const subtask = this.deps.subtaskRepo.findById(item.subtaskId);
    if (!subtask) throw new Error(`Kernel-authorized Subtask not found: ${item.subtaskId}`);
    const task = this.deps.taskRuntimeService.findTask(item.taskId);
    if (!task) throw new Error(`Kernel-authorized Task not found: ${item.taskId}`);
    for (const resource of input.request.newlyProvidedResources ?? []) {
      this.deps.taskRuntimeService.attachResource(task.id, resource);
    }
    if (task.status === 'created') this.deps.taskRuntimeService.transitionTask(task.id, 'ready');
    else if (task.status === 'parked') this.deps.taskRuntimeService.resumeParkedTask(task.id);
    else if (task.status === 'blocked') this.deps.taskRuntimeService.unblockTask(task.id);
    if (this.deps.taskRuntimeService.findTask(task.id)?.status === 'ready') {
      this.deps.taskRuntimeService.transitionTask(task.id, 'running');
    }
    this.deps.callbacks.setRunningExecutorName(
      item.taskId,
      item.subtaskId,
      item.attemptId,
      item.authorizedBinding.agentClassRef,
    );
    const acceptanceCriteria = subtask.acceptance.map(criterion => ({
      key: criterion.key,
      description: criterion.description,
      requiredEvidence: criterion.requiredEvidence,
    }));
    // 规范化的用户可见执行事实（§3.5）：显示名称 + 步骤字段，
    // 同时保留既有内部 ref 字段以兼容历史客户端。
    const display = buildExecutorDisplayFacts({
      identity: resolvePublicRoutingIdentity(
        this.deps.getRuntimeConfiguration?.(item.configurationRevision),
        item.authorizedBinding,
      ),
      subtaskId: item.subtaskId,
      subtaskTitle: subtask.title,
    });
    const dispatchStartedAt = new Date().toISOString();
    const bindingDetails = {
      executorName: item.authorizedBinding.agentClassRef,
      harnessRef: item.authorizedBinding.harnessRef,
      providerRef: item.authorizedBinding.providerRef,
      modelRef: item.authorizedBinding.modelRef,
      permissionProfileRef: item.authorizedBinding.permissionProfileRef,
      configurationRevision: item.configurationRevision,
      ...display,
    };
    this.appendExecutionTrace({
      phase: 'execution',
      actor: 'kernel',
      kind: 'executor_dispatch_started',
      status: 'running',
      title: 'Executor dispatch started',
      summary: `Kernel started ${item.authorizedBinding.agentClassRef} for "${subtask.title}".`,
      details: {
        taskId: item.taskId,
        attemptId: item.attemptId,
        attemptKind: item.attemptKind,
        recoveryMode: item.recoveryMode,
        subtaskGoal: subtask.goal,
        deliveryKind: subtask.deliveryKind,
        requiredCapabilities: subtask.requiredCapabilities,
        acceptanceCriteria,
        ...bindingDetails,
        ...executionEventDetails({
          display,
          step: {
            stepKey: 'executor_started',
            stepLabel: `已启动 ${display.executorDisplayName}`,
          },
          startedAt: dispatchStartedAt,
          updatedAt: dispatchStartedAt,
        }),
      },
      eventKey: `${item.attemptId}:dispatch_started`,
      taskId: item.taskId,
    });
    this.appendExecutionTrace({
      phase: 'execution',
      actor: 'runtime',
      kind: 'subtask_execution_started',
      status: 'running',
      title: `Executing Subtask: ${subtask.title}`,
      summary: `${subtask.goal} Delivery: ${subtask.deliveryKind}.`,
      details: {
        taskId: item.taskId,
        attemptId: item.attemptId,
        attemptKind: item.attemptKind,
        recoveryMode: item.recoveryMode,
        subtaskGoal: subtask.goal,
        deliveryKind: subtask.deliveryKind,
        requiredCapabilities: subtask.requiredCapabilities,
        acceptanceCriteria,
        ...bindingDetails,
        ...executionEventDetails({
          display,
          step: {
            stepKey: 'subtask_execution',
            stepLabel: `正在执行：${subtask.title}`,
            progress: null,
          },
          startedAt: dispatchStartedAt,
          updatedAt: dispatchStartedAt,
        }),
      },
      eventKey: `${item.attemptId}:subtask_started`,
      taskId: item.taskId,
    });
    this.deps.callbacks.appendOutput(
      ...this.deps.presentation.formatExecutorDispatch(
        item.authorizedBinding.agentClassRef,
      ),
    );

    const startedAtMs = Date.now();
    let lastProgressAtMs = startedAtMs;
    let lastProgressKind = 'dispatch_started';
    let progressSequence = 0;
    const onProgress = (event: ExecutorProgressEvent, executor: ExecutorAdapter): void => {
      input.progressTracker.onProgress(event, executor);
      const safeText = formatExecutorProgress(event.text);
      if (!safeText) return;
      lastProgressAtMs = Date.now();
      lastProgressKind = event.kind;
      progressSequence += 1;
      this.appendExecutionTrace({
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'running',
        title: `Executor progress: ${event.kind}`,
        summary: safeText,
        details: {
          taskId: item.taskId,
          attemptId: item.attemptId,
          progressKind: event.kind,
          progressSequence,
          ...bindingDetails,
          executorName: executor.name,
          ...executionEventDetails({
            display,
            step: {
              stepKey: 'executor_progress',
              stepLabel: safeText.slice(0, 120),
              progress: null,
            },
            startedAt: dispatchStartedAt,
          }),
        },
        eventKey: `${item.attemptId}:progress:${progressSequence}`,
        taskId: item.taskId,
      });
    };
    const heartbeatMs = this.deps.executionTraceHeartbeatMs
      ?? DEFAULT_EXECUTION_TRACE_HEARTBEAT_MS;
    let heartbeatSequence = 0;
    const heartbeat = heartbeatMs > 0
      ? setInterval(() => {
          const nowMs = Date.now();
          if (nowMs - lastProgressAtMs < heartbeatMs) return;
          heartbeatSequence += 1;
          this.appendExecutionTrace({
            phase: 'execution',
            actor: 'runtime',
            kind: 'executor_heartbeat',
            status: 'running',
            title: `Executor still running: ${subtask.title}`,
            summary: 'Executor is still running; no new public Harness event has arrived yet.',
            details: {
              taskId: item.taskId,
              attemptId: item.attemptId,
              elapsedMs: nowMs - startedAtMs,
              silentForMs: nowMs - lastProgressAtMs,
              lastProgressAt: new Date(lastProgressAtMs).toISOString(),
              lastProgressKind,
              heartbeatSequence,
              ...bindingDetails,
              ...executionEventDetails({
                display,
                step: {
                  stepKey: 'executor_waiting',
                  stepLabel: `仍在执行：${subtask.title}`,
                  progress: null,
                },
                startedAt: dispatchStartedAt,
              }),
            },
            eventKey: `${item.attemptId}:heartbeat:${heartbeatSequence}`,
            taskId: item.taskId,
          });
        }, heartbeatMs)
      : null;
    heartbeat?.unref();
    let outcome: SubtaskAttemptOutcome;
    try {
      outcome = item.attemptKind === 'contract_correction'
        && item.attemptPayload?.protocol === 'completion-correction-v2'
        && item.sourceAttemptId
        ? await this.deps.attemptRunner.runCorrection({
            attemptId: item.attemptId,
            sourceAttemptId: item.sourceAttemptId,
            executionId: input.executionId,
            taskId: item.taskId,
            subtaskId: item.subtaskId,
            authorizedBinding: item.authorizedBinding,
            bindingFingerprint: item.bindingFingerprint,
            completionContract: item.attemptPayload.completionContract,
            violations: item.attemptPayload.violations as Parameters<
              SubtaskAttemptRunner['runCorrection']
            >[0]['violations'],
          })
        : await this.deps.attemptRunner.run({
            attemptId: item.attemptId,
            executionId: input.executionId,
            taskId: item.taskId,
            subtaskId: item.subtaskId,
            authorizedBinding: item.authorizedBinding,
            bindingFingerprint: item.bindingFingerprint,
            executionMode: input.request.executionMode,
            attemptKind: item.attemptKind,
            attemptPayload: item.attemptPayload,
            sourceAttemptId: item.sourceAttemptId,
            recoveryMode: item.recoveryMode,
            defaultResourceGrant: item.resourceGrant,
            sourceRoot: input.request.workspacePath,
            onProgress,
          });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.deps.callbacks.clearRunningExecutorName(item.taskId, item.attemptId);
    }
    this.appendExecutorOutcomeTrace(item, outcome);

    if (outcome.outcome === 'capacity_unavailable') {
      this.appendExecutionTrace({
        phase: 'routing',
        actor: 'kernel',
        kind: 'executor_capacity_unavailable',
        status: 'blocked',
        title: 'Executor capacity unavailable',
        summary: `No capacity is currently available for ${item.authorizedBinding.agentClassRef}.`,
        details: {
          taskId: item.taskId,
          subtaskId: item.subtaskId,
          attemptId: item.attemptId,
          executorName: item.authorizedBinding.agentClassRef,
        },
        eventKey: `${item.attemptId}:capacity`,
        taskId: item.taskId,
      });
      return this.eventFromDispatchItem(item, {
        type: 'capacity_signal',
        authorizedBinding: item.authorizedBinding,
        bindingFingerprint: item.bindingFingerprint,
        available: false,
        cycleId: input.executionId,
        attemptKind: item.attemptKind,
        attemptPayload: item.attemptPayload,
      });
    }
    if (outcome.outcome === 'partition_conflict') {
      this.appendExecutionTrace({
        phase: 'authorization',
        actor: 'kernel',
        kind: 'kernel_waiting_for_partition',
        status: 'blocked',
        title: 'Kernel is waiting for a resource partition',
        summary: 'Execution is paused until the conflicting resource leases are released.',
        details: {
          taskId: item.taskId,
          subtaskId: item.subtaskId,
          attemptId: item.attemptId,
          conflictingLeaseCount: outcome.conflictingLeaseIds.length,
        },
        eventKey: `${item.attemptId}:partition`,
        taskId: item.taskId,
      });
      return this.eventFromDispatchItem(item, {
        type: 'partition_conflict_observed',
        claims: outcome.claims,
        conflictingLeaseIds: outcome.conflictingLeaseIds,
      });
    }
    if (item.attemptKind === 'merge_repair' && outcome.outcome !== 'completed') {
      const payload = item.attemptPayload;
      if (payload?.protocol !== 'metaclaw:merge-repair:v1') {
        throw new Error(`merge repair dispatch item has invalid payload: ${item.attemptId}`);
      }
      const publication = this.deps.publicationRepo.find(payload.publicationId);
      if (!publication || !publication.conflictChainId) {
        throw new Error(`merge repair publication is missing: ${payload.publicationId}`);
      }
      return {
        ...this.eventFromDispatchItem(item, {
          type: 'merge_conflict_observed',
          publicationId: publication.id,
          conflictChainId: publication.conflictChainId,
          authorizedBinding: item.authorizedBinding,
          bindingFingerprint: item.bindingFingerprint,
          sourceAttemptId: publication.sourceAttemptId,
          repairAttemptsUsed: publication.repairAttemptsUsed,
          conflictReplansUsed: publication.conflictReplansUsed,
          conflictingPaths: payload.conflictingPaths,
        }),
        id: mergeConflictObservationId(
          publication.id,
          publication.repairAttemptsUsed,
        ),
      } as KernelEvent;
    }
    this.projectExecutorOutcome(item.authorizedBinding, outcome);
    if (
      item.attemptKind === 'contract_correction'
      && outcome.outcome === 'completed'
      && outcome.resultId
    ) {
      this.deps.callbacks.recordResultDelivery({
        resultId: outcome.resultId,
        content: outcome.output,
        completeness: 'complete',
        certification: 'certified',
      });
      this.deps.callbacks.appendOutput(
        outcome.output,
        '',
        '原结果的完成认证已修复，任务继续收敛。',
      );
    }
    if (outcome.outcome === 'contract_failed') {
      if (outcome.output) {
        if (outcome.resultId && outcome.deliverability === 'deliverable') {
          this.deps.callbacks.recordResultDelivery({
            resultId: outcome.resultId,
            content: outcome.output,
            completeness: 'partial',
            certification: outcome.certification,
          });
        }
        this.deps.callbacks.appendOutput(
          outcome.output,
          '',
          outcome.certification === 'uncertified'
            ? '结果已返回，任务完成认证待处理。'
            : '结果已返回。',
        );
      }
      return this.eventFromDispatchItem(item, {
        type: 'execution_result_observed',
        workUnitId: outcome.workUnitId,
        authorizedBinding: item.authorizedBinding,
        bindingFingerprint: item.bindingFingerprint,
        contract: outcome.completionContract,
        violations: outcome.violations,
        receiptCount: outcome.receiptCount,
        responseBytes: outcome.responseBytes,
        resultId: outcome.resultId ?? null,
        deliverability: outcome.deliverability,
        certification: outcome.certification,
        safety: outcome.safety,
      });
    }
    return this.eventFromDispatchItem(item, {
      type: 'execution_outcome',
      terminalKind: outcome.outcome === 'completed' ? 'completed' : 'failed',
      authorizedBinding: item.authorizedBinding,
      bindingFingerprint: item.bindingFingerprint,
      attemptKind: item.attemptKind,
      sourceAttemptId: item.sourceAttemptId,
      failure: outcome.outcome === 'completed'
        ? null
        : outcome.outcome === 'executor_failed'
          ? outcome.failure
          : { kind: 'stale', scope: 'attempt', code: 'cancelled_or_stale', summary: outcome.reason },
    });
  }

  private eventFromDispatchItem(
    item: KernelDispatchItemRecord,
    event: Omit<KernelEvent, keyof import('../kernel/control-kernel.js').KernelEventEnvelope
      | 'schemaVersion' | 'id' | 'correlationId' | 'causationId' | 'occurredAt'
      | 'sessionId' | 'taskId' | 'subtaskId' | 'attemptId'> & Record<string, unknown>,
  ): KernelEvent {
    return {
      schemaVersion: 5,
      configurationRevision: item.configurationRevision,
      id: `event_${item.attemptId}_${String(event.type)}`,
      correlationId: item.decisionId,
      causationId: item.decisionId,
      occurredAt: new Date().toISOString(),
      ...this.ownerEnvelopeForTask(item.taskId),
      taskId: item.taskId,
      subtaskId: item.subtaskId,
      attemptId: item.attemptId,
      ...event,
    } as KernelEvent;
  }

  private ownerEnvelopeForTask(taskId: string | null): Pick<
    KernelEvent,
    'sessionId' | 'conversationId' | 'workspaceId'
  > {
    // A few recovery-only adapters intentionally expose no Task repository;
    // durable production dispatches still resolve the immutable owner here.
    const task = taskId ? this.deps.taskRuntimeService?.findTask(taskId) : null;
    return {
      sessionId: task?.ownerPlannerSessionId ?? this.sessionId,
      ...(task?.conversationId ? { conversationId: task.conversationId } : {}),
      ...(task?.workspaceId ? { workspaceId: task.workspaceId } : {}),
    };
  }

  private launchFailureEvent(item: KernelDispatchItemRecord, error: unknown): KernelEvent {
    const summary = error instanceof Error ? error.message : String(error);
    return this.eventFromDispatchItem(item, {
      type: 'execution_outcome',
      terminalKind: 'failed',
      authorizedBinding: item.authorizedBinding,
      bindingFingerprint: item.bindingFingerprint,
      attemptKind: item.attemptKind,
      sourceAttemptId: item.sourceAttemptId,
      failure: {
        kind: 'infrastructure',
        scope: 'attempt',
        code: 'dispatch_launch_failed',
        summary,
      },
    });
  }


  prepareExecution(input: KernelExecutionRuntimeInput): PreparedKernelExecutionInput {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    const graph = this.deps.workGraphRuntimeService.apply({
      task,
      userPrompt: input.request.userPrompt,
      sessionId: this.sessionId,
      authorizedWorkGraph: input.request.authorizedWorkGraph ?? null,
      authorizedBindingsBySubtask: input.request.authorizedBindingsBySubtask ?? null,
      authorization: input.request.workGraphAuthorization ?? null,
    });
    if (graph.outcome === 'not_executable' && input.request.authorizedWorkGraph) {
      throw new Error(`authorized Work Graph could not be persisted: ${graph.reason}`);
    }
    const authorization = input.request.workGraphAuthorization;
    if (
      graph.outcome !== 'not_executable'
      && authorization?.source === 'replan'
    ) {
      const request = this.deps.generationReplanRepo.findByGeneration(
        input.taskId,
        authorization.generationId,
        authorization.revision - 1,
      );
      if (request) {
        this.deps.generationReplanRepo.resolve(request.id, new Date().toISOString());
      }
    }
    return {
      ...input,
      graphState: graph.outcome === 'not_executable'
        ? graph.reason === 'missing_graph' ? 'missing' : 'conflict'
        : 'ready',
    };
  }

  async execute(input: PreparedKernelExecutionInput): Promise<void> {
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
    const graphState = input.graphState;

    const executionId = `exec_${generateInteractionId()}`;
    const progressTracker = this.deps.executionProgressService.createTracker({ taskId, executionId });
    const attemptFacts: KernelAttemptFact[] = [];
    const configurationRevision = this.configurationRevisionForTask(taskId);
    const stableFacts = this.buildDispatchStableFacts(configurationRevision);
    const retrySafeRecovery = input.recoveryOnly
      || request.executionMode === 'resume-blocked'
      || request.executionMode === 'resume-parked'
      ? this.retrySafeLegacySystemBindingRecovery(taskId, new Date().toISOString())
      : null;
    const initialEvent: KernelEvent = request.executionMode === 'resume-blocked'
      || request.executionMode === 'resume-parked'
      ? {
          schemaVersion: 5,
          configurationRevision,
          type: 'task_resume_requested',
          id: `resume_event_${taskId}_${request.kernelDecisionId ?? executionId}`,
          correlationId: request.kernelDecisionId ?? executionId,
          causationId: request.kernelDecisionId ?? null,
          occurredAt: new Date().toISOString(),
          sessionId: this.sessionId,
          taskId,
          blockerCategory: request.executionMode === 'resume-parked'
            ? 'parked'
            : retrySafeRecovery
              ? 'retry'
              : classifyResumeBlocker(
                  request.recoveryTrigger?.blockedReason,
                  this.deps.attemptReceiptRepo.listByTask(taskId)[0]?.failure,
                ),
          sourceInputExcerpt: request.recoveryTrigger?.sourceInputExcerpt
            ?? request.userPrompt.slice(0, 500),
          newlyProvidedResources: [...(request.newlyProvidedResources ?? [])],
          idempotencyKey: `resume:${taskId}:${request.kernelDecisionId ?? request.userPrompt.slice(0, 120)}`,
        }
      : {
          schemaVersion: 5,
          configurationRevision,
          type: 'dispatch_requested',
          id: `dispatch_event_${executionId}`,
          correlationId: request.kernelDecisionId ?? executionId,
          causationId: request.kernelDecisionId ?? null,
          occurredAt: new Date().toISOString(),
          sessionId: this.sessionId,
          taskId,
          reason: request.schedulingReason ?? 'authorized execution request',
        };
    const buildSnapshot = (event: KernelEvent): KernelSnapshot => event.type === 'plan_proposed'
      ? this.deps.callbacks.buildPlanAdmissionSnapshot(event)
      : event.type === 'partition_conflict_observed' ? {
          schemaVersion: 5,
          type: 'partition',
          conflictConfirmed: event.conflictingLeaseIds.length > 0,
          workspaceId: null,
          checkpointId: null,
        }
      : event.type === 'sandbox_lost' ? {
          schemaVersion: 5,
          type: 'sandbox_recovery',
          workspaceExists: Boolean(event.workspaceId),
          workspaceId: event.workspaceId,
          checkpointId: event.checkpointId,
          activeLeaseIds: [],
          defaultResourceGrant: defaultResourceGrant(
            task.id,
            this.deps.workGraphRevisionRepo.findActive(task.id)?.generationId
              ?? `generation_${task.id}_1`,
            event.subtaskId ?? 'pending',
          ),
        }
      : event.type === 'timer_tick' ? {
          schemaVersion: 5,
          type: 'timer',
          task: { id: task.id, status: task.status },
          wakeAuthorized: this.isKernelWakeAuthorized(task, event.wakeKind),
          capacityBlockedAt: null,
          recheckAfterMs: 0,
          capacityBindings: [],
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
          executorStatuses: stableFacts.executorStatuses,
          defaultResourceGrant: defaultResourceGrant(task.id, `generation_${task.id}_1`, event.subtaskId ?? 'pending'),
        }
      : event.type === 'recovery_resolution_requested' ? {
          schemaVersion: 5,
          type: 'recovery',
          task: { id: task.id, status: task.status },
          item: (() => {
            const application = this.deps.kernelWorkflowStore.findRecoveryItem?.(
              event.recoveryItemId,
            );
            return application
              ? {
                  id: application.id,
                  kind: 'application' as const,
                  status: application.status as 'uncertain' | 'failed',
                  retrySafe: true,
                }
              : null;
          })(),
        }
      : this.buildDispatchSnapshot(
          event.taskId ?? taskId,
          graphState,
          stableFacts,
          attemptFacts,
          event.type === 'execution_outcome'
            ? event.terminalKind === 'failed' ? event.subtaskId : null
            : event.type === 'handoff_contract_failed'
              || event.type === 'execution_result_observed'
              ? event.subtaskId
              : null,
          event.type === 'capacity_signal'
            ? this.capacityProbeFacts(event)
            : {},
        );
    let workflow: KernelWorkflow;
    const supervisorContext: AttemptSupervisorContext = {
      run: item => this.runDispatchItem({ item, executionId, request, progressTracker }),
      submit: event => workflow.submit(event),
      onLaunchError: async (item, error) => this.launchFailureEvent(item, error),
    };
    workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot,
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: decision => this.withDecisionSession(decision, () => (
          this.applyExecutionDecision({
            decision,
            executionId,
            request,
            progressTracker,
            supervisorContext,
            attemptFacts,
            finishExecution,
          })
        )),
      },
      acceptedEventTypes: [
        'dispatch_requested', 'task_resume_requested', 'capacity_signal', 'execution_outcome',
        'handoff_contract_failed', 'execution_result_observed',
        'timer_tick', 'plan_proposed',
        'partition_conflict_observed', 'sandbox_lost', 'merge_conflict_observed',
        'generation_quiescence_observed', 'recovery_resolution_requested',
      ],
      acceptedActions: [
        'resume_task', 'dispatch_batch', 'probe_capacity', 'wait_for_capacity', 'wait_for_retry',
        'block_work', 'park_for_replan', 'complete_task', 'request_replan',
        'queue_generation_replan',
        'request_merge_replan',
        'authorize_task_plan', 'defer_task_plan_for_availability', 'no_op',
        'wait_for_partition', 'recover_workspace_attempt', 'resolve_recovery',
      ],
      taskId,
    });
    this.attemptSupervisor.recover(taskId, supervisorContext);
    await this.recoverExpiredAttempts(workflow, attemptFacts);
    if (input.recoveryOnly) {
      if (retrySafeRecovery) await workflow.submit(retrySafeRecovery);
      else await workflow.recover();
    } else {
      if (retrySafeRecovery) await workflow.submit(retrySafeRecovery);
      const initialResult = await workflow.submit(initialEvent);
      const initialDecision = initialResult.decisions.find(
        decision => decision.eventId === initialEvent.id,
      );
      if (initialDecision) {
        try {
          input.onInitialDecision?.(initialDecision);
        } catch {
          // A presentation acknowledgement cannot change durable execution.
        }
      }
    }
    await this.attemptSupervisor.drain(taskId);
    await this.drainPublications({
      taskId,
      executionId,
      workflow,
    });
    await this.deps.cancellationCoordinator.recover(taskId);
    this.deps.cancellationCoordinator.settlePartialCancellation(taskId);
  }

  private async drainPublications(input: {
    taskId: string;
    executionId: string;
    workflow: KernelWorkflow;
  }): Promise<void> {
    while (true) {
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(input.taskId);
      if (!activeRevision) return;
      const outcomes = await this.deps.publicationWorker.drain(
        input.taskId,
        activeRevision.generationId,
      );
      if (outcomes.length === 0) return;
      let integrated = false;
      for (const outcome of outcomes) {
        if (outcome.type === 'conflicted') {
          await input.workflow.submit(outcome.event);
          await this.attemptSupervisor.drain(input.taskId);
          return;
        }
        if (outcome.type === 'cancelled') continue;
        integrated = true;
        this.projectIntegratedPublication(outcome);
      }
      if (integrated) {
        const lastIntegrated = [...outcomes].reverse().find(
          (outcome): outcome is Extract<WorkspacePublicationOutcome, { type: 'integrated' }> => (
            outcome.type === 'integrated'
          ),
        );
        await input.workflow.submit({
          schemaVersion: 5,
          configurationRevision: activeRevision.configurationRevision,
          type: 'dispatch_requested',
          id: `publication_dispatch_${input.executionId}_${lastIntegrated?.publicationId
            ?? activeRevision.revision}`,
          correlationId: input.executionId,
          causationId: lastIntegrated?.publicationId ?? null,
          occurredAt: new Date().toISOString(),
          sessionId: this.sessionId,
          taskId: input.taskId,
          reason: 'candidate publication released downstream frontier',
        });
        await this.attemptSupervisor.drain(input.taskId);
      }
    }
  }

  private projectIntegratedPublication(
    outcome: Extract<WorkspacePublicationOutcome, { type: 'integrated' }>,
  ): void {
    const subtask = this.deps.subtaskRepo.findById(outcome.subtaskId);
    const userArtifactCount = outcome.userArtifacts.length;
    // 发布成功的用户产物通过 recordResultDelivery 的既有通道投递，
    // artifact projection 由 Web 会话投影层按需附加。
    this.recordTaskEvent(outcome.taskId, outcome.subtaskId, 'subtask_done', subtask?.title ?? outcome.subtaskId, {
      attemptId: outcome.sourceAttemptId,
      executorName: outcome.agentClassName,
      warnings: outcome.warnings,
      integrationCommit: outcome.integrationCommit,
      userArtifactIds: outcome.userArtifacts.map(artifact => artifact.artifactId),
    });
    const publishedReceipt = this.deps.attemptReceiptRepo.findByAttemptId(outcome.sourceAttemptId);
    const publishedBinding = publishedReceipt?.authorizedBinding;
    const publicationBinding = {
      agentClassRef: publishedBinding?.agentClassRef ?? outcome.agentClassName,
      harnessRef: publishedBinding?.harnessRef ?? outcome.agentClassName,
      providerRef: publishedBinding?.providerRef ?? '',
      modelRef: publishedBinding?.modelRef ?? '',
      permissionProfileRef: publishedBinding?.permissionProfileRef ?? null,
      configurationRevision: publishedReceipt?.configurationRevision
        ?? this.configurationRevisionForTask(outcome.taskId),
    };
    const publishedDisplay = buildExecutorDisplayFacts({
      identity: resolvePublicRoutingIdentity(
        this.deps.getRuntimeConfiguration?.(publicationBinding.configurationRevision),
        publicationBinding,
      ),
      subtaskId: outcome.subtaskId,
      subtaskTitle: subtask?.title ?? outcome.subtaskId,
    });
    this.appendExecutionTrace({
      phase: 'delivery',
      actor: 'runtime',
      kind: 'publication_integrated',
      status: 'completed',
      title: 'Publication integrated',
      summary: `Subtask ${outcome.subtaskId} was integrated into the task workspace.`,
      details: {
        taskId: outcome.taskId,
        attemptId: outcome.sourceAttemptId,
        executorName: outcome.agentClassName,
        integrationCommit: outcome.integrationCommit,
        artifactCount: userArtifactCount,
        resultId: outcome.resultId ?? null,
        ...executionEventDetails({
          display: publishedDisplay,
          step: {
            stepKey: 'executor_published',
            stepLabel: userArtifactCount > 0
              ? `产物已发布（${userArtifactCount} 个文件）`
              : '执行结果已发布',
            progress: null,
          },
        }),
      },
      eventKey: `${outcome.publicationId}:integrated`,
      taskId: outcome.taskId,
    });
    if (outcome.resultId) {
      this.deps.callbacks.recordResultDelivery({
        resultId: outcome.resultId,
        content: outcome.output,
        completeness: 'complete',
        certification: 'certified',
      });
    }
    this.deps.callbacks.appendOutput(this.deps.presentation.formatExecutorFinalResult({
      executorName: outcome.agentClassName,
      taskId: outcome.taskId,
      subtaskId: outcome.subtaskId,
      output: outcome.output,
    }));
  }

  private appendExecutorOutcomeTrace(
    item: KernelDispatchItemRecord,
    outcome: SubtaskAttemptOutcome,
  ): void {
    const isCompleted = outcome.outcome === 'completed';
    const isContractResult = outcome.outcome === 'contract_failed';
    const status = isCompleted || isContractResult
      ? outcome.outcome === 'contract_failed' && outcome.safety === 'safety_blocked'
        ? 'blocked'
        : 'completed'
      : outcome.outcome === 'cancelled_or_stale'
        ? 'blocked'
        : 'failed';
    const outcomeDisplay = buildExecutorDisplayFacts({
      identity: resolvePublicRoutingIdentity(
        this.deps.getRuntimeConfiguration?.(item.configurationRevision),
        item.authorizedBinding,
      ),
      subtaskId: item.subtaskId,
      subtaskTitle: this.deps.subtaskRepo.findById(item.subtaskId)?.title ?? item.subtaskId,
    });
    this.appendExecutionTrace({
      phase: 'verification',
      actor: 'executor',
      kind: 'executor_result_observed',
      status,
      title: isCompleted ? 'Executor result observed' : 'Executor attempt settled',
      summary: isCompleted
        ? 'Executor completed the authorized attempt; Runtime is verifying the result.'
        : isContractResult
          ? 'Executor returned a result that Runtime is certifying for delivery.'
          : outcome.outcome === 'executor_failed'
            ? 'Executor failed; Kernel will decide recovery or retry.'
            : 'Executor attempt became stale or was cancelled.',
      details: {
        taskId: item.taskId,
        attemptId: item.attemptId,
        executorName: item.authorizedBinding.agentClassRef,
        outcome: outcome.outcome,
        ...(isContractResult ? {
          deliverability: outcome.deliverability,
          certification: outcome.certification,
          safety: outcome.safety,
          resultId: outcome.resultId ?? null,
        } : {}),
        ...(outcome.outcome === 'executor_failed' ? {
          failureCode: outcome.failure.code,
          ...(() => {
            const hint = describeAttemptFailure({
              failureCode: outcome.failure.code,
              errorDetail: 'detail' in outcome.failure ? String(outcome.failure.detail ?? '') : null,
            });
            return hint ? { failureHint: hint } : {};
          })(),
        } : {}),
        ...executionEventDetails({
          display: outcomeDisplay,
          step: {
            stepKey: 'executor_verifying',
            stepLabel: isCompleted
              ? `正在校验 ${outcomeDisplay.executorDisplayName} 的执行结果`
              : `执行结束：${outcome.outcome}`,
            progress: null,
          },
        }),
      },
      eventKey: `${item.attemptId}:result`,
      taskId: item.taskId,
    });
  }

  private async recoverExpiredAttempts(workflow: KernelWorkflow, attemptFacts: KernelAttemptFact[]): Promise<void> {
    for (const workUnit of this.deps.workUnitClaimService.sweepExpired()) {
      if (!workUnit.claimedTaskId || !workUnit.claimedSubtaskId || !workUnit.claimedAttemptId) continue;
      const task = this.deps.taskRuntimeService.findTask(workUnit.claimedTaskId);
      const subtask = this.deps.subtaskRepo.findById(workUnit.claimedSubtaskId);
      const dispatchItem = this.deps.dispatchItemRepo.find(workUnit.claimedAttemptId);
      if (
        !task
        || task.status === 'cancelled'
        || !subtask
        || !dispatchItem
        || subtask.status === 'done'
        || subtask.status === 'cancelled'
      ) continue;
      this.deps.attemptRunner.landHeartbeatLost({
        attemptId: workUnit.claimedAttemptId,
        executionId: `heartbeat_${workUnit.claimedAttemptId}`,
        taskId: task.id,
        subtaskId: subtask.id,
        workUnitId: workUnit.id,
        authorizedBinding: dispatchItem.authorizedBinding,
        bindingFingerprint: dispatchItem.bindingFingerprint,
      });
      await workflow.recover();
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
    const configurationRevision = this.configurationRevisionForTask(task.id);
    const stableFacts = this.buildDispatchStableFacts(configurationRevision);
    let applied = false;
    const finishExecution = async (lines: string[]) => {
      this.deps.callbacks.clearRunningExecutorName(task.id);
      this.deps.callbacks.refreshRuntimeState();
      this.deps.callbacks.appendOutput(...lines);
    };
    const initialEvent: KernelEvent = {
      schemaVersion: 5,
      configurationRevision,
      type: 'timer_tick',
      id: `timer_event_${input.blockedDecisionId}_${input.occurredAt}`,
      correlationId: input.blockedDecisionId,
      causationId: input.blockedDecisionId,
      occurredAt: input.occurredAt,
      sessionId: this.sessionId,
      taskId: task.id,
      subtaskId: subtask.id,
      wakeKind: 'capacity',
      sourceDecisionId: input.blockedDecisionId,
      scheduledFor: input.occurredAt,
      retry: null,
    };
    let workflow: KernelWorkflow;
    const supervisorContext: AttemptSupervisorContext = {
      run: item => this.runDispatchItem({ item, executionId, request, progressTracker }),
      submit: event => workflow.submit(event),
      onLaunchError: async (item, error) => this.launchFailureEvent(item, error),
    };
    workflow = new DurableKernelWorkflow({
      kernel: this.deps.controlKernel,
      buildSnapshot: event => event.type === 'plan_proposed'
        ? this.deps.callbacks.buildPlanAdmissionSnapshot(event)
        : event.type === 'partition_conflict_observed' ? {
            schemaVersion: 5,
            type: 'partition',
            conflictConfirmed: event.conflictingLeaseIds.length > 0,
            workspaceId: null,
            checkpointId: null,
          }
        : event.type === 'sandbox_lost' ? {
            schemaVersion: 5,
            type: 'sandbox_recovery',
            workspaceExists: Boolean(event.workspaceId),
            workspaceId: event.workspaceId,
            checkpointId: event.checkpointId,
            activeLeaseIds: [],
            defaultResourceGrant: defaultResourceGrant(
              task.id,
              this.deps.workGraphRevisionRepo.findActive(task.id)?.generationId
                ?? `generation_${task.id}_1`,
              event.subtaskId ?? 'pending',
            ),
          }
        : event.type === 'timer_tick' ? {
            schemaVersion: 5,
            type: 'timer',
            task: { id: task.id, status: task.status },
            wakeAuthorized: this.isKernelWakeAuthorized(task, event.wakeKind),
            capacityBlockedAt: input.blockedAt,
            recheckAfterMs: input.recheckAfterMs,
            capacityBindings: subtask.executorBindings,
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
            executorStatuses: stableFacts.executorStatuses,
            defaultResourceGrant: defaultResourceGrant(task.id, subtask.generationId, subtask.id),
          }
        : this.buildDispatchSnapshot(task.id, 'ready', stableFacts),
      store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() },
      runtime: {
        apply: decision => this.withDecisionSession(decision, async () => {
          if (decision.action.type !== 'no_op') applied = true;
          return this.applyExecutionDecision({
            decision,
            executionId,
            request,
            progressTracker,
            supervisorContext,
            attemptFacts: [],
            finishExecution,
          });
        }),
      },
      acceptedEventTypes: [
        'dispatch_requested', 'capacity_signal', 'execution_outcome',
        'handoff_contract_failed', 'execution_result_observed',
        'timer_tick', 'plan_proposed',
        'partition_conflict_observed', 'sandbox_lost', 'merge_conflict_observed',
        'generation_quiescence_observed',
      ],
      acceptedActions: [
        'dispatch_batch', 'probe_capacity', 'wait_for_capacity', 'wait_for_retry',
        'block_work', 'park_for_replan', 'complete_task', 'request_replan',
        'queue_generation_replan',
        'request_merge_replan',
        'authorize_task_plan', 'defer_task_plan_for_availability', 'no_op',
        'wait_for_partition', 'recover_workspace_attempt',
      ],
      taskId: task.id,
    });
    await workflow.submit(initialEvent);
    await this.attemptSupervisor.drain(task.id);
    await this.drainPublications({
      taskId: task.id,
      executionId,
      workflow,
    });
    await this.deps.cancellationCoordinator.recover(task.id);
    this.deps.cancellationCoordinator.settlePartialCancellation(task.id);
    return applied;
  }

  private async blockTask(
    taskId: string,
    reason: string,
    finishExecution: (lines: string[], scheduleNext?: boolean) => Promise<void>,
    dependencyType: import('../core/types.js').Dependency['type'] = 'manual',
  ): Promise<void> {
    if (this.deps.taskRuntimeService.findTask(taskId)?.status === 'running') {
      this.deps.taskRuntimeService.blockTask(taskId, {
        taskId,
        type: dependencyType,
        description: reason,
        status: 'waiting',
      });
    }
    this.recordTaskEvent(taskId, null, 'phase2_execution_blocked', reason, {});
    await finishExecution([`Execution blocked: ${reason}`]);
  }

  private isKernelWakeAuthorized(task: import('../core/types.js').Task, wakeKind: Extract<KernelEvent, { type: 'timer_tick' }>['wakeKind']): boolean {
    const expectedType = wakeKind === 'retry'
      ? 'kernel_retry'
      : wakeKind === 'capacity'
        ? 'kernel_capacity'
        : 'kernel_availability';
    return task.status === 'blocked'
      && task.dependencies.some(dependency => dependency.status === 'waiting' && dependency.type === expectedType);
  }

  private async completeTask(input: {
    taskId: string;
    decisionId: string;
    executionId: string;
    request: QueuedExecutionRequest;
    subtasks: Subtask[];
    cancelledSubtasks?: Subtask[];
    completionKind?: 'full' | 'partial_accepted';
    revisionCompletion?: {
      revision: number;
      completionKind: 'full' | 'partial_accepted';
    };
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
    const cancelledSubtasks = input.cancelledSubtasks ?? [];
    const completionKind = input.completionKind ?? 'full';
    const aggregateParts = (summary: string) => [
      completionKind === 'partial_accepted'
        ? `Task #${input.taskId} completed with an explicitly accepted partial result.`
        : `Task #${input.taskId} completed ${input.subtasks.length} Subtask(s).`,
      summary,
      cancelledSubtasks.length > 0
        ? `Cancelled Subtasks:\n${cancelledSubtasks.map(subtask => `- ${subtask.id}: ${subtask.title}`).join('\n')}`
        : '',
      warnings.length > 0 ? `Warnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}` : '',
      artifacts.length > 0 ? `Artifacts:\n${artifacts.map(path => `- ${path}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const cleanAggregate = aggregateParts(persistedSummary);
    const displayAggregate = aggregateParts(displaySummary);

    const effectId = `effect_${input.decisionId}_task_completion`;
    const effectPayload = {
      taskId: input.taskId,
      title: task.title,
      summary: cleanAggregate,
      output: cleanAggregate,
      artifactPaths: artifacts,
      durationMs: 0,
      executionMode: input.request.executionMode,
      origin: input.request.origin ?? 'user',
      recoveryTrigger: input.request.recoveryTrigger,
      completionKind,
      cancelledSubtaskIds: cancelledSubtasks.map(subtask => subtask.id),
    };
    this.deps.effectOutboxRepo.transaction(() => {
      if (input.revisionCompletion) {
        this.deps.workGraphRevisionRepo.complete(
          input.taskId,
          input.revisionCompletion.revision,
          new Date().toISOString(),
          input.revisionCompletion.completionKind,
        );
      }
      this.deps.taskRuntimeService.updateTask(input.taskId, { summary: cleanAggregate, artifacts });
      this.deps.persistenceService.recordInteraction({
        taskId: input.taskId,
        sessionId: this.sessionId,
        userInput: input.request.userPrompt,
        systemOutput: cleanAggregate,
        executorUsed: input.subtasks.length === 1
          ? input.subtasks[0]!.executorBindings[0]?.agentClassRef ?? 'executor'
          : 'work-graph',
      });
      if (['running', 'blocked'].includes(
        this.deps.taskRuntimeService.findTask(input.taskId)?.status ?? '',
      )) {
        this.deps.taskRuntimeService.transitionTask(input.taskId, 'done');
      }
      const now = new Date().toISOString();
      this.deps.effectOutboxRepo.enqueue({
        id: effectId,
        decisionId: input.decisionId,
        taskId: input.taskId,
        effectType: 'task_completion_notification',
        payload: effectPayload,
        availableAt: now,
      });
    });
    const completionLines: string[] = [];
    this.deps.callbacks.setFocusContext({ kind: 'task', taskId: input.taskId });
    this.deps.callbacks.persistSessionState({ lastFocusedTaskId: input.taskId, lastCompletedTaskId: input.taskId });
    completionLines.push(displayAggregate);

    let deliveryMessage: string | null = null;
    await this.deps.effectOutboxRepo.deliver(effectId, async () => {
      deliveryMessage = await this.deps.verificationAndDeliveryService.deliverTaskCompletion(
        this.deps.notifier,
        effectPayload,
      );
      return effectId;
    }, () => new Date().toISOString());
    if (deliveryMessage) this.deps.callbacks.appendOutput(deliveryMessage);
    this.appendExecutionTrace({
      phase: 'delivery',
      actor: 'runtime',
      kind: 'delivery_completed',
      status: 'completed',
      title: 'Final answer delivered',
      summary: 'The verified Executor result was delivered to the Conversation.',
      details: {
        taskId: input.taskId,
        completionKind,
        subtaskCount: input.subtasks.length,
        artifactCount: artifacts.length,
        warningCount: warnings.length,
      },
      eventKey: `${effectId}:delivered`,
      taskId: input.taskId,
      traceStatus: 'completed',
    });

    await input.finishExecution(completionLines);
    await this.deps.onTaskTerminal?.(input.taskId);
  }

  private projectExecutorOutcome(
    authorizedBinding: AuthorizedExecutorBinding,
    outcome: SubtaskAttemptOutcome,
  ): void {
    if (outcome.outcome !== 'completed' && outcome.outcome !== 'executor_failed') return;
    const succeeded = outcome.outcome === 'completed';
    this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
      agentClassName: authorizedBinding.agentClassRef,
      configurationRevision: authorizedBinding.configurationRevision,
      attemptId: outcome.attemptId,
      outcome: succeeded ? 'succeeded' : 'failed',
      failure: succeeded ? null : outcome.outcome === 'executor_failed' ? outcome.failure : null,
    });
  }

  private projectPersistedReceipt(receipt: import('../storage/executor-attempt-receipt-repo.js').ExecutorAttemptReceipt): void {
    if (receipt.terminalState === 'uncertified_result') return;
    this.deps.kernelExecutorStatusProjector.recordExecutionOutcome({
      agentClassName: receipt.agentClassName,
      configurationRevision: receipt.configurationRevision,
      attemptId: receipt.attemptId,
      outcome: receipt.terminalState === 'completed' ? 'succeeded' : 'failed',
      failure: receipt.terminalState === 'completed' ? null : receipt.failure,
      completedAt: receipt.completedAt,
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

  private configurationRevisionForTask(taskId: string): string {
    return this.deps.workGraphRevisionRepo.findActive(taskId)?.configurationRevision
      ?? this.deps.getConfigurationRevision();
  }
}
