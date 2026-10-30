import { TaskOperationKeys } from '../storage/task-state-change-repo.js';
import { projectTaskView, type TaskView } from '../task/task-view.js';
import type { TaskActivityFactsReader } from '../task/task-activity-facts.js';
import { projectPublicDelivery, type PublicDeliveryView } from '../delivery/public-delivery-view.js';
import { PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION } from './managed-local-service.js';
import type { ManagedLocalServices } from './managed-local-service.js';
import { LOCAL_SERVICE_SPECIFICATION_FILENAME } from './managed-local-service.js';
import { isServiceReadyState, localServiceSpecificationRevision, type LocalServiceOperation, type LocalServiceView } from '../task/local-service.js';
import type { PendingResultIdentity } from '../task/safe-result-identity.js';
import { ExecutorProbeError } from './work-unit-claim-service.js';
// Execution application service: Session supplies facade callbacks but owns no runtime policy.
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  type KernelRetryWakeFact,
  type KernelSnapshot,
  type RemainingTaskWork,
} from '../kernel/control-kernel.js';
import {
  DurableKernelWorkflow,
  KernelApplicationInterruptedError,
  KernelApplicationRejectionError,
  KernelApplicationSettledError,
  type KernelWorkflow,
  type KernelWorkflowStore,
} from '../kernel/kernel-workflow.js';
import type { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import type { MemoryEvidencePort } from '../memory/memory-evidence-service.js';
import { deriveRecoverySafety } from '../routing/types.js';
import type { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import type { RetryWakeRepo } from '../storage/retry-wake-repo.js';
import type {
  ExecutorAttemptReceipt,
  ExecutorAttemptReceiptRepo,
} from '../storage/executor-attempt-receipt-repo.js';
import { buildDefaultResourceClaims } from '../resource/index.js';
import { deriveRunnableFrontier } from '../work-graph/index.js';
import type { KernelDispatchItemRepo, KernelDispatchItemRecord } from '../storage/kernel-dispatch-item-repo.js';
import type { ExecutorAttemptRuntimeRepo } from '../storage/executor-attempt-runtime-repo.js';
import type { KernelDecisionRepo } from '../storage/kernel-decision-repo.js';
import type { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { canonicalizeWorkspacePath } from '../workspace/workspace-path.js';
import { workspaceExecutionBindingFingerprint } from './execution-context.js';
import {
  WorktreeExecutionCleanupService,
  type WorktreeCleanupOutcome,
} from './worktree-execution-cleanup.js';
import { ManagedGitWorkspaceService } from './managed-git-workspace.js';
import { TERMINAL_TASK_STATUSES } from '../task/task-state.js';
import type { ResultObjectRepo } from '../storage/result-object-repo.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import type { GenerationReplanRequestRepo } from '../storage/generation-replan-request-repo.js';
import type { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';
import { AttemptSupervisor, type AttemptSupervisorContext } from './attempt-supervisor.js';
import type {
  CancellationReceipt,
  TaskCancellationCoordinator,
} from './task-cancellation-coordinator.js';
import {
  reconcileUncertainCancellations,
  type CancellationReconciliationEntry,
} from './cancellation-reconciliation.js';
import {
  createSubtaskLifecyclePort,
  type SubtaskLifecyclePort,
} from '../task/task-lifecycle-transition-port.js';
import type { TaskClearOutcome } from '../task/task-control-types.js';
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

type LocalServiceApplyOutcome =
  | { readonly type: 'result'; readonly view: LocalServiceView | null }
  | { readonly type: 'rejected'; readonly reason: string }
  | { readonly type: 'settled'; readonly view: LocalServiceView | null; readonly error: string };

const DEFAULT_EXECUTION_TRACE_HEARTBEAT_MS = 10_000;

/**
 * Runtime mirror of the Kernel's service repair budget (2026-10-27 realignment
 * §4.3). The Kernel refuses a round past its own limit; the Runtime uses the
 * same bound to stop driving its verification loop.
 */
const MAX_SERVICE_REPAIR_ROUNDS = 3;


function boundRefusal(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 400 ? normalized : `${normalized.slice(0, 399)}…`;
}

/**
 * Durable count of consumed service repair rounds, per Subtask.
 *
 * A cancelled dispatch never ran, so it must not consume the Kernel's bounded
 * repair budget. In-flight and settled rounds do: reusing their ordinal would
 * authorize two attempts for the same round.
 */
function serviceRepairRoundCounts(
  items: readonly import('../storage/kernel-dispatch-item-repo.js').KernelDispatchItemRecord[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (item.attemptPayload?.protocol !== 'metawork:service-repair:v1') continue;
    if (item.status === 'cancelled') continue;
    counts[item.subtaskId] = (counts[item.subtaskId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Resolve a registered service through the composite Workspace identity.
 *
 * `findForWorkspace` is the Runtime contract; focused fixtures that only wire
 * the legacy `find` port keep working through the bare lookup.
 */
function resolveRegisteredService(
  services: {
    findForWorkspace?(workspaceId: string | null, serviceId: string): import('../task/local-service.js').LocalServiceRecord | null;
    find(serviceId: string): import('../task/local-service.js').LocalServiceRecord | null;
  },
  workspaceId: string | null,
  serviceId: string,
): import('../task/local-service.js').LocalServiceRecord | null {
  return services.findForWorkspace
    ? services.findForWorkspace(workspaceId, serviceId)
    : services.find(serviceId);
}

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
  includeRecoverable?: boolean;
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
    if (target.status !== 'ready'
      && !(input.includeRecoverable && ['blocked', 'awaiting_decision'].includes(target.status))) continue;
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
          code: source.status === 'blocked' || source.status === 'cancelled' ? 'missing_handoff' : 'pending_publication',
          terminal: source.status === 'blocked' || source.status === 'cancelled',
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
        continue;
      }
      if (input.includeRecoverable) facts.push({ sourceSubtaskId: source.id, targetSubtaskId: target.id,
        code: 'ready', terminal: true, detail: 'published dependency is available' });
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
  dependencyReadiness: NonNullable<Extract<KernelSnapshot, { type: 'dispatch' }>['dependencyReadiness']>;
  supportsEvidenceTools(binding: AuthorizedExecutorBinding): boolean;
}): Extract<KernelSnapshot, { type: 'dispatch' }>['resumeRecoveryCandidates'] {
  const activeSubtaskIds = new Set(input.dispatchItems
    .filter(item => ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status))
    .map(item => item.subtaskId));
  // An executor can settle after the Task/Subtask fence has changed. In that
  // race the dispatch item is durable as `uncertain`, but no receipt exists
  // and the Subtask may still be `running`. Keep that residue recoverable by
  // an explicit resume instead of leaving the graph with no legal frontier.
  const uncertainDispatchBySubtask = new Map(
    input.dispatchItems
      .filter(item => item.status === 'uncertain')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(item => [item.subtaskId, item]),
  );
  const latestReceiptBySubtask = new Map<string, ExecutorAttemptReceipt>();
  for (const receipt of input.receipts) {
    if (!latestReceiptBySubtask.has(receipt.subtaskId)) {
      latestReceiptBySubtask.set(receipt.subtaskId, receipt);
    }
  }
  const candidates = input.subtasks.flatMap(subtask => {
    if (activeSubtaskIds.has(subtask.id)) return [];
    const receipt = latestReceiptBySubtask.get(subtask.id);
    const uncertainDispatch = uncertainDispatchBySubtask.get(subtask.id);
    const orphanedDispatch = Boolean(
      uncertainDispatch
      && !receipt
      && subtask.status === 'running'
      && uncertainDispatch.generationId === subtask.generationId
      && uncertainDispatch.configurationRevision === input.configurationRevision
      && uncertainDispatch.bindingFingerprint === authorizedExecutorBindingFingerprint(
        uncertainDispatch.authorizedBinding,
      )
      && subtask.executorBindings.some(binding =>
        authorizedExecutorBindingFingerprint(binding) === uncertainDispatch.bindingFingerprint
      ),
    );
    if (!['awaiting_decision', 'blocked'].includes(subtask.status) && !orphanedDispatch) return [];
    if (orphanedDispatch && uncertainDispatch) {
      if (deriveRecoverySafety(subtask.requiredCapabilities) === 'external_non_idempotent') return [];
      const workspace = input.workspaceRepository.findByIdentity(
        uncertainDispatch.taskId,
        uncertainDispatch.generationId,
        uncertainDispatch.subtaskId,
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
        sourceAttemptId: uncertainDispatch.attemptId,
        authorizedBinding: uncertainDispatch.authorizedBinding,
        bindingFingerprint: uncertainDispatch.bindingFingerprint,
        // There is no receipt to resume as a native session. The workspace
        // remains authoritative for files already produced by the attempt.
        recoveryMode: 'recovery_packet' as const,
        reason: 'execution_interrupted' as const,
      }];
    }
    if (
      !receipt
      || receipt.generationId !== subtask.generationId
      || receipt.configurationRevision !== input.configurationRevision
      || receipt.bindingFingerprint !== authorizedExecutorBindingFingerprint(
        receipt.authorizedBinding,
      )
      || !subtask.executorBindings.some(binding =>
        authorizedExecutorBindingFingerprint(binding) === receipt.bindingFingerprint
      )
    ) return [];
    const upstreamInputRestored = receipt.terminalState === 'executor_failed'
      && receipt.failure?.kind === 'task_failed'
      && receipt.errorCode === 'missing_upstream_input'
      && receipt.failure?.code === 'missing_upstream_input'
      && subtask.dependencies.length > 0
      && subtask.dependencies.every(dependency => input.dependencyReadiness.some(fact =>
        fact.targetSubtaskId === subtask.id && fact.sourceSubtaskId === dependency.fromSubtaskId
        && fact.code === 'ready'))
      && input.supportsEvidenceTools(receipt.authorizedBinding);
    const interrupted = upstreamInputRestored || receipt.failure !== null && ['executor_failed', 'heartbeat_lost'].includes(receipt.terminalState)
      && ['network', 'timeout', 'infrastructure', 'heartbeat_lost', 'configuration', 'adapter'].includes(receipt.failure.kind);
    if (!interrupted && (receipt.terminalState !== 'uncertified_result' || receipt.failure !== null
      || receipt.verification.violations.length === 0
      || receipt.attemptKind === 'contract_correction'
      || receipt.verification.violations.some(item => item.code !== 'completion_malformed' || item.path === 'reportPath'))) return [];
    const violation = receipt.verification.violations[0];
    const recoveryReason = upstreamInputRestored ? 'upstream_input_restored' as const
      : interrupted ? 'execution_interrupted' as const : violation?.code === 'completion_malformed' && violation.path === 'marker'
      ? 'completion_marker_missing' as const
      : violation?.code === 'completion_malformed'
          ? 'completion_metadata_invalid' as const
        : null;
    if (!recoveryReason) return [];
    const metadataCorrection = !interrupted;
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
      recoveryMode: !upstreamInputRestored && input.nativeContinuationAgentClasses.includes(
        receipt.authorizedBinding.agentClassRef,
      ) ? 'native_session' as const : 'recovery_packet' as const,
      reason: recoveryReason,
      ...(metadataCorrection ? {
        attemptKind: 'contract_correction' as const,
        correctionFacts: {
          receiptCount: input.receipts.filter(item => item.subtaskId === subtask.id
            && item.generationId === subtask.generationId && item.terminalState === 'uncertified_result').length,
          responseBytes: Buffer.byteLength(receipt.rawResponse, 'utf8'),
        },
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
  committedReasonCode?: import('../task/task-state.js').TaskReasonCode,
): import('../kernel/control-kernel.js').KernelResumeBlockerCategory {
  const normalized = reason?.toLowerCase() ?? '';
  // The committed Task reason is authoritative: a purely user-facing wait has no
  // unresolved external blocker, and the explicit resume is its resolution.
  // A committed unknown external outcome is fail-closed: resume must first
  // reconcile the effect, whatever the raw failure text says.
  if (committedReasonCode === 'external_outcome_unknown') return 'unknown';
  if (normalized && committedReasonCode === 'input_required') return 'user_wait';
  if (normalized && committedReasonCode === 'system_anomaly') return 'user_wait';
  // 启动恢复对“活跃但无 authorized dispatch”的 Subtask 只做 fail-closed 手动阻塞；
  // 描述里的 "authorized" 指 dispatch 授权，而不是缺材料/权限，不能归为 explicit_resource。
  if (normalized.includes('executor environment unavailable') || normalized.includes('no healthy authorized executor')) return 'availability';
  if (normalized.includes('without authorized dispatch')) return 'manual';
  if (normalized.includes('external effect safety')) return 'manual';
  if (normalized.includes('contract') || normalized.includes('契约')) return 'contract';
  // This is the Server's known authorization gate, not an unknown Executor
  // failure. Explicit resume rechecks the current productionAuthorization fact
  // in Kernel; recognizing the old reason does not grant execution permission.
  if (normalized.startsWith('official authorization state:')
    || normalized === 'official_authorization_required') return 'explicit_resource';
  if (/permission|权限|授权|material|材料|explicit.resource/iu.test(normalized)) return 'explicit_resource';
  if (latestFailure?.kind === 'unknown') {
    const classified = normalizeExecutorFailure(latestFailure.summary);
    if (classified.kind === 'network' || classified.code === 'model_response_incomplete') return 'retry';
  }
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
  // A user pause (or a Task waiting only for its user) has no unresolved
  // fail-closed external blocker; the explicit resume command is the resolution.
  if (!normalized || normalized === '未知原因') return 'user_wait';
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
  initialEvent?: KernelEvent;
  /** Application-Shell acknowledgement for the first authoritative execution decision. */
  onInitialDecision?(decision: KernelDecision): void;
}

export interface PreparedKernelExecutionInput extends KernelExecutionRuntimeInput {
  graphState: 'ready' | 'missing' | 'conflict';
}

export interface KernelExecutionRuntimeDeps {
  taskActivityFacts?: TaskActivityFactsReader;
  userArtifactPublication?: import('../delivery/user-artifact-publication-service.js').UserArtifactPublicationService;
  resolveUserWorkspaceRoot?: (sessionId: string) => Promise<string | null> | string | null;
  managedLocalServices?: ManagedLocalServices;
  sessionId: string;
  getSessionId?(): string;
  getConfigurationRevision(): string;
  getRuntimeConfiguration?: (revisionId: string) => RuntimeConfigurationView | null;
  orchestration: OrchestrationEngine;
  notifier: NotificationService;
  taskRuntimeService: TaskRuntimeService;
  /** Recomputes the one Task conclusion from durable facts (six-state model). */
  taskStateAuthority: import('../task/task-state-authority.js').TaskStateAuthority;
  /** Normalized operation results (service start, delivery, integration). */
  taskOperationResults: Pick<
    import('../storage/task-operation-result-repo.js').TaskOperationResultRepo,
    'record' | 'listByTask'
  >;
  /** Resolves a task's conversation workspace path when the queued request
   *  does not carry one (timer/recovery requests historically omitted it,
   *  which broke continuation dispatches with a missing workspace source). */
  resolveWorkspacePath?: (taskId: string) => Promise<string | null>;
  /** Canonical Workspace preflight immediately before an Executor attempt. */
  preflightWorkspacePath?: (path: string) => Promise<string>;
  agentClassService: AgentClassService;
  workGraphRuntimeService: WorkGraphRuntimeService;
  /**
   * Long-term memory delivery. The Runtime materializes the memory references
   * of an authorized work graph into execution evidence before the attempt
   * starts (design §10).
   */
  memoryEvidence?: MemoryEvidencePort;
  subtaskRepo: SubtaskRepo;
  workGraphRevisionRepo: WorkGraphRevisionRepo;
  effectOutboxRepo: KernelEffectOutboxRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  historicalResultUpgrader?: Pick<HistoricalResultUpgrader, 'upgrade'>;
  subtaskHandoffRepo: SubtaskHandoffRepo;
  taskEventRepo: TaskEventRepo;
  workUnitClaimService: WorkUnitClaimService;
  attemptRunner: SubtaskAttemptRunner;
  attemptRuntimeRepo?: ExecutorAttemptRuntimeRepo;
  controlKernel: ControlKernel;
  kernelWorkflowStore: KernelWorkflowStore & {
    findEvent?(eventId: string): KernelEvent | null;
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
  /** Wake the account scheduler after a durable continuation is queued. */
  onTaskQueued?(taskId: string): void | Promise<void>;
  executionTraceHeartbeatMs?: number;
  publicationWorker: WorkspacePublicationWorker;
  publicationRepo: WorkspacePublicationRepo;
  resultObjectRepo: ResultObjectRepo;
  workspaceRepository: WorkspaceRepositoryPort;
  generationReplanRepo: GenerationReplanRequestRepo;
  retryWakeRepo: RetryWakeRepo;
  resourceLeaseService?: import('./resource-lease-service.js').ResourceLeaseService;
  conversationWorktrees?: import('./conversation-worktree-service.js').ConversationWorktreeService;
  serviceWorktrees?: import('./service-worktree-service.js').ServiceWorktreeService;
  workspaceMergeWorker?: import('./workspace-merge-worker.js').WorkspaceMergeWorker;
  workspaceExecutionBindingRepo?: import('../storage/workspace-execution-binding-repo.js').WorkspaceExecutionBindingRepo;
  workspaceStore?: import('./workspace-store.js').WorkspaceStore;
  /**
   * Task blocker and Retry Wake are one durable wait_for_retry postcondition.
   * The account composition supplies the SQLite transaction; focused legacy
   * callers may omit it and still exercise the same idempotent ordering.
   */
  runInTransaction?<T>(operation: () => T): T;
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
    }): Promise<KernelEvent | null>;
    requestMergeReplan(decision: KernelDecision & {
      action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
    }): Promise<KernelEvent | null>;
    buildPlanAdmissionSnapshot(event: Extract<KernelEvent, { type: 'plan_proposed' }>): KernelSnapshot;
  };
  /** Read-only Server authorization projection consumed by Kernel snapshots. */
  productionAuthorization?: () => { allowed: boolean; reason?: string };
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
  /**
   * Subtask node lifecycle, owned by the Task Domain. Task state itself goes
   * through `TaskStateAuthority`; this Runtime never picks a Task status.
   */
  private readonly lifecycle: SubtaskLifecyclePort;

  constructor(private readonly deps: KernelExecutionRuntimeDeps) {
    this.taskEvents = new TaskEventRecorder(deps.taskEventRepo);
    this.lifecycle = createSubtaskLifecyclePort({ subtaskRepo: deps.subtaskRepo });
    this.attemptSupervisor = new AttemptSupervisor(
      deps.dispatchItemRepo,
      deps.maxConcurrentAttempts,
      deps.maxConcurrentAttemptsPerTask ?? deps.maxConcurrentAttempts,
      {}, deps.productionAuthorization,
    );
  }

  private get sessionId(): string {
    return this.decisionSession.getStore()
      ?? this.deps.getSessionId?.()
      ?? this.deps.sessionId;
  }

  /**
   * Asks the Task state authority to recompute the Task conclusion from the
   * durable facts this Runtime just wrote. The Runtime never picks a status.
   */
  private reconcileTaskState(
    taskId: string,
    input: {
      decisionId: string;
      operationKey: string;
      reason: string;
      facts?: () => readonly string[];
      resumeAuthorized?: boolean;
    },
  ): void {
    this.deps.taskStateAuthority.reconcile({
      taskId,
      decisionId: input.decisionId,
      operationKey: input.operationKey,
      actor: 'kernel-execution-runtime',
      reason: input.reason,
      resumeAuthorized: input.resumeAuthorized,
      ...(input.facts ? { facts: input.facts } : {}),
    });
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

  /**
   * `/task clear` semantics (§5.3.7): reports the actual durable outcome —
   * cleared / already cleared / recovery in progress / clear blocked — and
   * whether every admission surface was released.
   */
  async cancelTaskWithOutcome(
    taskId: string,
    reason = 'explicit Task cancellation command',
  ): Promise<TaskClearOutcome> {
    const before = this.deps.taskRuntimeService.findTask(taskId);
    const alreadyCancelled = before?.status === 'cancelled';
    try {
      await this.cancelTask(taskId, reason);
    } catch (error) {
      return {
        taskId,
        status: 'clear_blocked',
        residue: [],
        phase: error instanceof Error ? error.message : String(error),
      };
    }
    const residue = this.deps.cancellationCoordinator.completionBlockedReasons(taskId, null);
    if (residue.length === 0) {
      // No asynchronous cleanup is pending: release the Conversation slot and
      // close the schedule entry right now so the outcome is accurate (§4.1).
      // AccountRuntime owns the follow-up launch after promotion. Keeping the
      // release and launch in that callback prevents a promoted row from being
      // left in `reserved` when this synchronous command path is used.
      if (this.deps.onTaskTerminal) {
        await this.deps.onTaskTerminal(taskId);
      } else {
        this.deps.cancellationCoordinator.releaseAdmission(taskId);
      }
      await this.cleanupWorktreeExecutions(taskId);
      return {
        taskId,
        status: alreadyCancelled ? 'already_cleared' : 'cleared',
        residue: [],
      };
    }
    return {
      taskId,
      status: 'recovery_in_progress',
      residue,
    };
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

  async retryRemainingWork(taskId: string): Promise<CancellationReceipt> {
    const source = this.deps.taskRuntimeService.findTask(taskId);
    if (!source) throw new Error('任务不存在');
    const retryId = `task_retry_${taskId}_${source.stateVersion}`;
    const existing = this.deps.taskRuntimeService.listTasks().find(task => task.retryOfTaskId === taskId);
    if (existing) return { taskId: existing.id, affectedSubtaskIds: [], cleanupAttemptIds: [] };
    const graph = this.deps.workGraphRevisionRepo.findActive(taskId)
      ?? this.deps.workGraphRevisionRepo.findLatest(taskId);
    const facts = this.deps.taskStateAuthority.readFacts(taskId);
    const publications = this.deps.publicationRepo.listByTask(taskId)
      .filter(item => item.generationId === graph?.generationId && item.status === 'integrated'
        && this.deps.subtaskRepo.findById(item.subtaskId)?.graphRevision === graph?.revision);
    const nodes = this.deps.subtaskRepo.listActiveByTask(taskId);
    const remaining: RemainingTaskWork | null = graph ? {
      sourceTaskId: taskId, sourceVersion: source.stateVersion,
      generationId: graph.generationId, graphRevision: graph.revision,
      publicationIds: publications.filter(item => this.deps.publicationRepo.delivery(item.id)?.status === 'failed')
        .map(item => item.id),
      // Service operations are keyed per source Attempt and repair round, so the
      // remaining work reads the latest service outcome instead of one key.
      startService: source.startServiceAfterPublish === true
        && this.latestServiceOutcome(taskId) !== 'success',
    } : null;
    // Never infer reusable output from a done label. Every node must have an
    // integrated immutable candidate, and no unsafe external operation may remain.
    const inPlace = source.executionMode === 'in_place';
    // In-place execution has no isolated publication row to reuse: the
    // completed Executor already wrote the authorized files into the bound
    // Workspace. A failed service-start round therefore retries only the
    // service requirement after proving every execution node settled.
    const executionReceipts = facts?.receipts.filter(receipt => nodes.some(node => node.id === receipt.subtaskId)) ?? [];
    const executionSettledInPlace = inPlace && nodes.length > 0
      && nodes.every(node => node.status === 'done')
      && executionReceipts.length >= nodes.length
      && nodes.every(node => executionReceipts.some(receipt => receipt.subtaskId === node.id
        && (receipt.terminalState === 'completed' || receipt.accepted === true)));
    const safeToRetry = (inPlace ? executionSettledInPlace
      : nodes.length > 0 && nodes.every(node => publications.some(item => item.subtaskId === node.id)))
      && !facts?.externalOutcomeUnknown
      && this.deps.cancellationCoordinator.completionBlockedReasons(taskId, null).length === 0;
    let rejected: string | null = null;
    const event: KernelEvent = { schemaVersion: 5, type: 'task_remaining_work_retry_requested',
      id: `retry_remaining:${taskId}:${source.stateVersion}`, configurationRevision: this.configurationRevisionForTask(taskId),
      taskId, expectedVersion: source.stateVersion, correlationId: taskId, causationId: null,
      sessionId: this.sessionId, occurredAt: new Date().toISOString() };
    const workflow = new DurableKernelWorkflow({ kernel: this.deps.controlKernel,
      productionAuthorization: this.deps.productionAuthorization, store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() }, taskId,
      acceptedEventTypes: ['task_remaining_work_retry_requested'],
      acceptedActions: ['retry_remaining_work', 'reject_request'],
      buildSnapshot: () => ({ schemaVersion: 5, type: 'remaining_work_retry',
        task: { id: source.id, status: source.status }, remaining, safeToRetry }),
      runtime: { apply: async decision => {
        if (decision.action.type === 'reject_request') { rejected = decision.reason; return null; }
        if (decision.action.type !== 'retry_remaining_work') return null;
        const action = decision.action;
        this.deps.effectOutboxRepo.transaction(() => {
          const now = new Date().toISOString();
          const task = this.deps.taskRuntimeService.createTask({ id: action.taskId,
            title: `重试剩余工作：${source.title}`, goal: source.goal, retryOfTaskId: source.id,
            accountId: source.accountId, conversationId: source.conversationId, workspaceId: source.workspaceId,
            ownerPlannerSessionId: source.ownerPlannerSessionId,
            // Remaining-work retry is a new Task identity, but it is the same
            // authorized Workspace operation. Carry every immutable Workspace
            // fact forward instead of letting TaskEngine defaults reselect
            // Worktree or revive the historical generated task directory.
            ...(source.publicProject && source.publicTaskDirectory
              ? { publicTaskDirectory: source.publicTaskDirectory }
              : {}),
            publicDeliveryBaseline: source.publicDeliveryBaseline,
            startServiceAfterPublish: action.remaining.startService,
            executionMode: source.executionMode,
            workspaceExecutionSource: source.workspaceExecutionSource,
            workspaceDeliveryPolicy: source.workspaceDeliveryPolicy,
            workspaceTargetPaths: source.workspaceTargetPaths,
            workspaceIntent: source.workspaceIntent,
          });
          const generationId = `generation_${task.id}`;
          this.deps.workGraphRevisionRepo.activate({ id: `revision_${task.id}_1`, taskId: task.id,
            revision: 1, generationId, configurationRevision: decision.configurationRevision,
            authorizedDecisionId: decision.id, proposalSource: 'initial', automaticReplan: false,
            createdAt: now, updatedAt: now, completionRequirements: [
              ...action.remaining.publicationIds.map(id => ({ key: `delivery:${id}`, kind: 'delivery' as const,
                label: '补交付已生成的文件', subtaskId: null, serviceId: null })),
              ...(action.remaining.startService ? [{ key: 'service', kind: 'service' as const,
                label: '启动已交付的服务', subtaskId: null, serviceId: null }] : []),
            ] });
          this.deps.effectOutboxRepo.enqueue({ id: `remaining_work:${task.id}`, decisionId: decision.id,
            taskId: task.id, effectType: 'task_remaining_work', payload: { remaining: action.remaining }, availableAt: now });
          this.deps.conversationTaskSchedulerRepo!.enqueueTask(task.id, task.conversationId!, now, {
            requestText: source.goal, generationId, graphRevision: 1, workGraph: null,
            authorizedBindingsBySubtask: null, workspaceId: task.workspaceId ?? null,
            plannerSessionId: task.ownerPlannerSessionId ?? this.sessionId, executionMode: 'follow-up',
            remainingWork: true, schedulingReason: 'explicit remaining work retry',
          });
          this.deps.kernelWorkflowStore.markApplied(decision.id, null, now);
        });
        return null;
      } },
    });
    await workflow.submit(event);
    if (rejected) throw new Error(rejected);
    if (!this.deps.taskRuntimeService.findTask(retryId)) throw new Error('重试尚未获批');
    if (this.deps.onTaskTerminal) await this.deps.onTaskTerminal(taskId);
    else this.deps.cancellationCoordinator.releaseAdmission(taskId);
    await this.recoverDue(retryId, 'explicit remaining work retry');
    return { taskId: retryId, affectedSubtaskIds: [], cleanupAttemptIds: [] };
  }

  private async resumeRemainingWork(taskId: string): Promise<boolean> {
    const effect = this.deps.effectOutboxRepo?.listByTaskAndType?.(taskId, 'task_remaining_work')[0];
    if (!effect) return false;
    const task = this.deps.taskRuntimeService.findTask(taskId)!;
    if (effect.status === 'sent' || !['queued', 'running'].includes(task.status)) return true;
    const scheduler = this.deps.conversationTaskSchedulerRepo!;
    const conversationId = task.conversationId!;
    let slot = scheduler.getSlot(conversationId);
    if (slot.state === 'free' && !this.deps.onTaskTerminal
      && !scheduler.listSlots().some(item => item.activeTaskId !== null)) {
      scheduler.promoteNextQueued(conversationId, new Date().toISOString());
      slot = scheduler.getSlot(conversationId);
    }
    if (slot.activeTaskId !== taskId || slot.state !== 'occupied') return true;
    const remaining = effect.payload.remaining as RemainingTaskWork;
    const assertCurrent = () => {
      const current = scheduler.getSlot(conversationId);
      const owner = this.deps.taskRuntimeService.findTask(taskId);
      if (owner?.retryOfTaskId !== remaining.sourceTaskId
        || !['queued', 'running'].includes(owner.status)
        || current.activeTaskId !== taskId || current.reservationId !== slot.reservationId
        || current.slotVersion !== slot.slotVersion || current.state !== 'occupied') {
        throw new Error('剩余工作预约已过期');
      }
    };
    assertCurrent();
    scheduler.markRunning(taskId, new Date().toISOString());
    this.reconcileTaskState(taskId, { decisionId: effect.decisionId,
      operationKey: `remaining_started:${effect.id}`, reason: 'reserved remaining work started' });
    if (effect.status === 'uncertain' || effect.status === 'failed') {
      this.deps.effectOutboxRepo.resolve(effect.id, 'retry', new Date().toISOString());
    }
    const delivered = await this.deps.effectOutboxRepo.deliver(effect.id, async () => {
      for (const publicationId of remaining.publicationIds) {
        assertCurrent();
        const success = await this.deps.publicationWorker.redeliverForRetry(taskId, publicationId, assertCurrent);
        assertCurrent();
        this.recordOperationResult({ taskId, operationKey: `delivery:${publicationId}`, operationKind: 'delivery',
          outcome: success ? 'success' : 'definite_failure', reasonCode: success ? null : 'delivery_failed',
          message: success ? '文件补交付成功。' : '文件补交付失败。', evidenceRefs: [`publication:${publicationId}`] });
        if (!success) return taskId;
      }
      if (remaining.startService) {
        assertCurrent();
        const manager = this.deps.managedLocalServices;
        if (!manager) throw new Error('受管服务能力不可用');
        const source = this.deps.taskRuntimeService.findTask(remaining.sourceTaskId)!;
        const files = this.deps.userArtifactPublication?.taskArtifactRepo.publicFiles
          .list(source.accountId ?? 'local-default', source.id) ?? [];
        // Worktree retries verify immutable published bytes. In-place retries
        // launch from the bound Workspace and have no public-file manifest.
        if (source.executionMode !== 'in_place') {
          await manager.verifyPublishedFiles(source.id, files);
        }
        assertCurrent();
        await this.startRequestedPublishedService(taskId);
      }
      return taskId;
    }, () => new Date().toISOString());
    if (delivered.status === 'uncertain') {
      this.recordOperationResult({ taskId, operationKey: `remaining_unknown:${effect.id}`, operationKind: 'execution',
        outcome: 'unknown', reasonCode: 'external_outcome_unknown', message: delivered.errorSummary ?? '剩余工作需要核实', evidenceRefs: [effect.id] });
      this.reconcileTaskState(taskId, { decisionId: effect.decisionId, operationKey: `remaining_unknown:${effect.id}`,
        reason: delivered.errorSummary ?? 'remaining work requires verification' });
    }
    if (delivered.status === 'sent') {
      this.reconcileTaskState(taskId, { decisionId: effect.decisionId,
        operationKey: `remaining_finished:${effect.id}`, reason: 'remaining work settled' });
      const settled = this.deps.taskRuntimeService.findTask(taskId)!;
      if (['succeeded', 'failed'].includes(settled.status)) {
        if (settled.status === 'succeeded') this.deps.workGraphRevisionRepo.complete(taskId, 1, new Date().toISOString(), 'full');
        if (this.deps.onTaskTerminal) await this.deps.onTaskTerminal(taskId);
        else this.deps.cancellationCoordinator.releaseAdmission(taskId);
      } else if (this.latestServiceOutcome(taskId) === 'repair_pending') {
        // This path has no execution workflow, so the durable repair request it
        // just recorded needs one drive to be dispatched. The repair loop then
        // runs inside that drive (2026-10-27 realignment §4.3).
        await this.execute(this.prepareExecution({
          taskId,
          request: {
            userPrompt: task.goal,
            contextTaskId: task.id,
            executionMode: 'follow-up',
            origin: 'system',
            schedulingReason: 'service repair continuation',
          },
          recoveryOnly: true,
        }));
      }
    }
    return true;
  }

  /** User-facing manual block. Records the durable blocker, then reconciles. */
  async blockTask(taskId: string, reason: string): Promise<void> {
    await this.manualBlockTask(taskId, reason);
  }

  private async manualBlockTask(taskId: string, reason: string): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      throw new Error(`任务已结束，无法标记为待处理: ${task.status}`);
    }
    await this.blockTaskInternal(taskId, reason || '用户标记为需要处理');
  }

  async acceptPartialResult(taskId: string, expectedResult?: PendingResultIdentity): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({
      schemaVersion: 5,
      configurationRevision: this.configurationRevisionForTask(taskId),
      type: 'partial_result_acceptance_requested',
      expectedResult,
      id: `partial_accept_${generateInteractionId()}`,
      correlationId: taskId,
      causationId: null,
      occurredAt: new Date().toISOString(),
      sessionId: this.sessionId,
      taskId,
    });
  }

  async retryTaskResult(taskId: string, expectedResult: PendingResultIdentity): Promise<CancellationReceipt> {
    return this.submitTaskControlEvent({ schemaVersion: 5, configurationRevision: this.configurationRevisionForTask(taskId),
      type: 'task_result_retry_requested', expectedResult, id: `result_retry_${generateInteractionId()}`,
      correlationId: taskId, causationId: null, occurredAt: new Date().toISOString(), sessionId: this.sessionId, taskId });
  }

  pendingTaskResult(taskId: string): PendingResultIdentity | null {
    const snapshot = this.deps.cancellationCoordinator.buildSnapshot(taskId);
    return snapshot.uncertifiedResult && snapshot.generationId && snapshot.graphRevision
      ? { taskId, generationId: snapshot.generationId, graphRevision: snapshot.graphRevision, ...snapshot.uncertifiedResult } : null;
  }

  taskView(taskId: string): TaskView | null {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    return task && this.deps.taskActivityFacts ? projectTaskView(this.deps.taskActivityFacts.read(task, null)) : null;
  }

  async publicTaskDelivery(taskId: string): Promise<PublicDeliveryView | null> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) return null;
    const graph = this.deps.workGraphRevisionRepo.findActive(taskId);
    const binding = graph
      ? this.deps.workspaceExecutionBindingRepo?.find(task.id, graph.generationId) ?? null
      : this.deps.workspaceExecutionBindingRepo?.findLatestForTask(task.id) ?? null;
    // A Task view must describe the Workspace that was authorized for that
    // Generation. Once the durable binding repository is wired, a missing
    // binding is an unavailable view rather than a reason to use the current
    // Conversation root (which may have changed since admission). Focused
    // fixtures without the repository retain their local resolver fallback.
    const workspace = binding?.canonicalPath
      ?? (this.deps.workspaceExecutionBindingRepo
        ? null
        : (task.conversationId ? await this.deps.resolveUserWorkspaceRoot?.(task.conversationId) : null)
          ?? this.deps.userArtifactPublication?.userWorkspaceRoot ?? null);
    return projectPublicDelivery({ task, workspace,
      artifacts: [...(this.deps.userArtifactPublication?.taskArtifactRepo.publicFiles.list(task.accountId ?? 'local-default', taskId) ?? []),
        ...(this.deps.userArtifactPublication?.taskArtifactRepo.listByTask(taskId).filter(item => item.accountId === (task.accountId ?? 'local-default')) ?? [])],
      publications: this.deps.publicationRepo.listByTask(taskId).filter(item => item.generationId === graph?.generationId
        && this.deps.subtaskRepo.findById(item.subtaskId)?.graphRevision === graph?.revision),
      delivery: id => this.deps.publicationRepo.delivery(id) });
  }

  async localServiceTaskId(serviceId: string, conversationId?: string): Promise<string | null> {
    const services = this.deps.managedLocalServices;
    if (!services) return null;
    const records = services.listForService?.(serviceId)
      ?? [services.find(serviceId)].filter((record): record is NonNullable<typeof record> => record !== null);
    const tasks = this.deps.taskRuntimeService.listTasks?.() ?? [];
    const matches = records.filter(record => {
      const task = tasks.find(candidate => candidate.id === record.specification.taskId);
      if (!task || (conversationId && task.conversationId !== conversationId)) return false;
      return (task.workspaceId ?? '') === (record.workspaceId ?? '');
    });
    if (matches.length > 1) throw new Error('当前会话中存在多个同名服务，请指定服务所属任务');
    return matches[0]?.specification.taskId ?? null;
  }

  async readLocalService(serviceId: string, logs = false, taskId?: string): Promise<LocalServiceView | string> {
    const services = this.deps.managedLocalServices;
    if (!services) throw new Error('当前 Runtime 未配置受管服务');
    const workspaceId = taskId ? await services.resolveServiceWorkspaceId(taskId) : undefined;
    return logs ? services.logs(serviceId, workspaceId) : services.status(serviceId, workspaceId);
  }

  async manageLocalService(taskId: string, operation: LocalServiceOperation, serviceId?: string,
    turnId?: string | null, settleTask = true): Promise<LocalServiceView> {
    const services = this.deps.managedLocalServices;
    if (!services) throw new KernelApplicationRejectionError('当前 Runtime 未配置受管服务', 'service_runtime_unavailable');
    const resourceTaskId = this.deps.taskRuntimeService.findTask(taskId)?.retryOfTaskId ?? taskId;
    let specification: import('../task/local-service.js').LocalServiceSpecification | undefined;
    if (operation === 'start' || operation === 'update') {
      try {
        // A follow-up run resolves its own target project: the delivered
        // project's manifest, its recorded contract, or a launch discovered
        // from the project itself. A missing `.metawork-service.json` is not a
        // reason to stop (2026-10-28 transparent execution §P0.3).
        specification = (await services.resolveServiceSpecification({
          taskId: resourceTaskId,
          serviceId,
          allowRevisionChange: operation === 'update',
        })).specification;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new KernelApplicationRejectionError(message, 'service_not_startable', `taskId=${taskId} ${message}`);
      }
    }
    const id = specification?.serviceId ?? serviceId;
    if (!id) throw new KernelApplicationRejectionError('请指定服务标识', 'service_id_missing', `taskId=${taskId}`);
    const workspaceId = await services.resolveServiceWorkspaceId(resourceTaskId);
    const specificationRevision = specification
      ? localServiceSpecificationRevision(specification)
      : resolveRegisteredService(services, workspaceId, id)?.specificationRevision ?? '';
    const event: Extract<KernelEvent, { type: 'managed_service_requested' }> = {
      schemaVersion: 5, configurationRevision: this.configurationRevisionForTask(taskId),
      type: 'managed_service_requested', id: `service_${generateInteractionId()}`, correlationId: taskId,
      causationId: null, occurredAt: new Date().toISOString(), sessionId: this.sessionId,
      taskId, operation, serviceId: id, specification, workspaceId, specificationRevision,
      ...(turnId ? { turnId } : {}),
    };
    const published = await services.isPublished(resourceTaskId);
    const observed: { outcome: LocalServiceApplyOutcome | null } = { outcome: null };
    const workflow = this.localServiceWorkflow(taskId, published, value => { observed.outcome = value; });
    await workflow.submit(event);
    if (observed.outcome?.type === 'rejected') throw new KernelApplicationRejectionError(observed.outcome.reason, 'service_request_rejected', observed.outcome.reason);
    if (observed.outcome?.type === 'settled') throw new KernelApplicationSettledError(observed.outcome.error, 'service_operation_failed', observed.outcome.error);
    const result = observed.outcome?.view ?? null;
    if (!result) throw new Error('服务操作未完成，请查询当前状态');
    if (settleTask && isServiceReadyState(result.state)
      && this.deps.taskRuntimeService.findTask(taskId)?.status === 'running') {
      await this.recoverDue(taskId, 'explicit service operation released health gate');
    }
    return result;
  }

  private localServiceWorkflow(taskId: string, published: boolean,
    observe: (value: LocalServiceApplyOutcome | null) => void = () => undefined): DurableKernelWorkflow {
    const services = this.deps.managedLocalServices!;
    return new DurableKernelWorkflow({
      productionAuthorization: this.deps.productionAuthorization,
      kernel: this.deps.controlKernel, store: this.deps.kernelWorkflowStore,
      clock: { now: () => new Date().toISOString() }, taskId,
      acceptedEventTypes: ['managed_service_requested'],
      acceptedActions: ['control_managed_service', 'reject_request', 'no_op'],
      buildSnapshot: event => {
        const task = this.deps.taskRuntimeService.findTask(taskId);
        const id = event.type === 'managed_service_requested' ? event.serviceId : '';
        // Service identity is the composite (account, workspace, service); an
        // identically named service in another Workspace is not this record.
        const registered = resolveRegisteredService(
          services,
          event.type === 'managed_service_requested' ? event.workspaceId ?? null : null,
          id,
        );
        return { schemaVersion: 5, type: 'service_control', task: task ? { id: task.id, status: task.status } : null,
          serviceHandedOver: (this.deps.taskRuntimeService.listTasks?.() ?? []).some(candidate =>
            candidate.retryOfTaskId === taskId && candidate.status === 'succeeded'
              && candidate.startServiceAfterPublish === true),
          published, retryOfTaskId: task?.retryOfTaskId,
          serviceTaskId: registered?.specification.taskId ?? null,
          serviceWorkspaceId: registered?.workspaceId ?? null,
          serviceRevision: registered?.specificationRevision ?? null };
      },
      runtime: { apply: async decision => {
        const action = decision.action;
        if (action.type === 'reject_request') { observe({ type: 'rejected', reason: decision.reason }); return null; }
        if (action.type === 'control_managed_service') {
          const effect = await services.applyAuthorizedOperation({ decisionId: decision.id, ...action });
          observe(effect.error
            ? { type: 'settled', view: effect.result, error: effect.error }
            : { type: 'result', view: effect.result });
        }
        return null;
      } },
    });
  }

  private async recoverLocalServiceOperations(taskId: string): Promise<void> {
    const services = this.deps.managedLocalServices;
    if (!services) return;
    // Only journalled service effects have deterministic replay semantics.
    // Their checkpoints distinguish stopping from launching after a crash.
    for (const application of this.deps.kernelWorkflowStore.listUncertainApplications?.(['control_managed_service'], taskId) ?? []) {
      this.deps.kernelWorkflowStore.resolveUncertainApplication?.(application.decisionId, 'retry', new Date().toISOString());
    }
    await this.localServiceWorkflow(taskId, await services.isPublished(taskId)).recover();
    for (const record of services.forTask(taskId)) {
      await services.status(record.specification.serviceId, record.workspaceId);
    }
  }

  /** Persist the Workspace facts that authorize a Generation before dispatch. */
  async bindWorkspaceExecution(
    taskId: string,
    generationId: string,
    workspaceIdHint?: string | null,
  ): Promise<import('../storage/workspace-execution-binding-repo.js').WorkspaceExecutionBinding | import('../workspace/workspace-git-contracts.js').ConversationExecutionBinding | null> {
    const conversations = this.deps.conversationWorktrees;
    if (conversations) {
      const existing = conversations.repo.binding(taskId, generationId);
      if (existing) return existing;
      const legacy = this.deps.workspaceExecutionBindingRepo?.find(taskId, generationId);
      if (legacy) throw new Error('legacy_execution_requires_replan');
      const task = this.deps.taskRuntimeService.findTask(taskId);
      const userRoot = await this.deps.resolveWorkspacePath?.(taskId);
      const workspaceId = workspaceIdHint ?? task?.workspaceId;
      if (!task?.conversationId || !workspaceId || !userRoot) throw new Error('conversation_workspace_binding_required');
      return conversations.bind({accountId: task.accountId ?? 'local-default', workspaceId,
        conversationId: task.conversationId, userRoot, taskId, generationId});
    }
    const repo = this.deps.workspaceExecutionBindingRepo;
    if (!repo) return null;
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) return null;
    const existing = repo.find(taskId, generationId);
    if (existing) return existing;
    const workspaceId = workspaceIdHint ?? task.workspaceId ?? null;
    const resolved = this.deps.resolveWorkspacePath
      ? await this.deps.resolveWorkspacePath(taskId)
      : null;
    if (!workspaceId || !resolved) return null;
    const canonical = await canonicalizeWorkspacePath(resolved).catch(() => null);
    if (!canonical) return null;
    const executionMode = task.executionMode ?? 'in_place';
    if (executionMode === 'worktree') {
      throw new Error(`Task ${taskId} uses a retired Worktree binding and cannot be dispatched`);
    }
    // A replan of an existing Task keeps the mode of its first generation; a
    // later generation never reinterprets the current settings.
    const inherited = repo.findLatestForTask(taskId);
    if (inherited && inherited.executionMode !== executionMode) {
      throw new Error(
        `workspace execution mode is immutable for Task ${taskId}: `
        + `binding=${inherited.executionMode}, task=${executionMode}`,
      );
    }
    const now = new Date().toISOString();
    const authorizedWorkingDirectory = canonical.canonicalPath;
    return repo.upsert({
      taskId,
      generationId,
      workspaceId,
      canonicalPath: canonical.canonicalPath,
      executionMode,
      authorizedWorkingDirectory,
      modeSource: task.workspaceExecutionSource ?? inherited?.modeSource ?? null,
      deliveryPolicy: task.workspaceDeliveryPolicy ?? inherited?.deliveryPolicy ?? null,
      workspaceIntent: task.workspaceIntent ?? inherited?.workspaceIntent ?? null,
      targetPaths: task.workspaceTargetPaths ?? inherited?.targetPaths ?? [],
      createdAt: now,
      updatedAt: now,
    });
  }

  async recoverCancellations(taskId?: string): Promise<void> {
    await this.trackCancellationDrain(
      taskId ? `recover:${taskId}` : 'recover:all',
      () => this.deps.cancellationCoordinator.recover(taskId),
    );
  }

  /**
   * Reconciles uncertain cancellation applications (2026-09-06 plan §5.3):
   * resolves already-applied / replayable state durably and keeps admission
   * closed with a named phase for contradictory state.
   */
  reconcileCancellationApplications(taskId?: string): CancellationReconciliationEntry[] {
    const entries = reconcileUncertainCancellations({
      store: this.deps.kernelWorkflowStore,
      coordinator: this.deps.cancellationCoordinator,
      taskRuntimeService: this.deps.taskRuntimeService,
      onResolved: resolvedTaskId => {
        void this.startCancellationDrain(resolvedTaskId);
      },
    }, taskId);
    for (const entry of entries) {
      if (entry.outcome !== 'unresolved') continue;
      this.appendExecutionTrace({
        phase: 'verification',
        actor: 'kernel',
        kind: 'cancellation_reconciliation_unresolved',
        status: 'failed',
        title: 'Uncertain cancellation requires attention',
        summary: `Task ${entry.taskId} cancellation application ${entry.decisionId} could not converge.`,
        details: { diagnostics: entry.diagnostics },
        eventKey: `cancellation_reconciliation_unresolved:${entry.decisionId}`,
      });
    }
    return entries;
  }

  /**
   * Pre-admission reconciliation (§5.3.6): releases legacy
   * blocked+occupied+running combinations for one Conversation before the
   * Planner classifies a same-topic conflict.
   */
  reconcileConversationAdmission(conversationId: string): {
    releasedStaleSlot: boolean;
    reconciliation: CancellationReconciliationEntry[];
  } {
    const scheduler = this.deps.conversationTaskSchedulerRepo;
    if (!scheduler) return { releasedStaleSlot: false, reconciliation: [] };
    const slot = scheduler.getSlot(conversationId);
    const activeTaskId = slot.state === 'free' ? null : slot.activeTaskId;
    if (!activeTaskId) return { releasedStaleSlot: false, reconciliation: [] };
    const task = this.deps.taskRuntimeService.findTask(activeTaskId);
    if (!task) return { releasedStaleSlot: false, reconciliation: [] };
    const reconciliation = this.reconcileCancellationApplications(activeTaskId);
    if (['cancelled', 'succeeded', 'failed'].includes(task.status)) {
      // §4.1: never release the slot while dispatch/publication/backend/lease
      // residue remains — releaseAdmission re-checks every blocking category.
      const released = this.deps.onTaskTerminal
        ? null
        : this.deps.cancellationCoordinator.releaseAdmission(
          activeTaskId,
          new Date().toISOString(),
        );
      if (this.deps.onTaskTerminal) void this.deps.onTaskTerminal(activeTaskId);
      this.deps.callbacks.refreshRuntimeState();
      return { releasedStaleSlot: released !== null, reconciliation };
    }
    return { releasedStaleSlot: false, reconciliation };
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
        productionAuthorization: this.deps.productionAuthorization,
        kernel: this.deps.controlKernel,
        buildSnapshot: () => ({
          schemaVersion: 5,
          type: 'availability_recovery',
          task: task ? {
            id: task.id,
            status: task.status,
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            ...(task.executionMode ? { executionMode: task.executionMode } : {}),
            ...(task.workspaceDeliveryPolicy ? { deliveryPolicy: task.workspaceDeliveryPolicy } : {}),
          } : null,
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
            if (currentRequest?.status !== 'waiting_for_availability'
              || !currentTask
              || currentTask.status === 'succeeded'
              || currentTask.status === 'failed'
              || currentTask.status === 'cancelled') {
              return null;
            }
            const result = this.deps.workGraphRuntimeService.apply({
        conversationGit: Boolean(this.deps.conversationWorktrees),
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
            this.reconcileTaskState(currentTask.id, {
              decisionId: decision.id,
              operationKey: `availability_activated:${currentRequest.id}`,
              reason: 'deferred availability proposal activated',
            });
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
        | 'partial_result_acceptance_requested' | 'task_result_retry_requested';
    }>,
  ): Promise<CancellationReceipt> {
    let receipt: CancellationReceipt | null = null;
    let controlError: string | null = null;
    let authorizedPublicationIds = 0;
    const workflow = new DurableKernelWorkflow({
      productionAuthorization: this.deps.productionAuthorization,
      kernel: this.deps.controlKernel,
      buildSnapshot: () => this.deps.cancellationCoordinator.buildSnapshot(event.taskId!,
        event.type === 'partial_result_acceptance_requested' ? event.expectedResult : undefined),
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
          if (decision.action.type === 'accept_uncertified_result' || decision.action.type === 'retry_uncertified_result') {
            const action = decision.action;
            const pending = this.deps.cancellationCoordinator.buildSnapshot(action.taskId).uncertifiedResult;
            const graph = this.deps.workGraphRevisionRepo.findActive(action.taskId);
            if (!pending || pending.attemptId !== action.attemptId || pending.resultId !== action.resultId
              || graph?.generationId !== action.generationId || graph.revision !== action.graphRevision) {
              controlError = '该结果操作已过期，请刷新任务后重试。';
              return null;
            }
            const operationKey = action.type === 'accept_uncertified_result'
              ? TaskOperationKeys.acceptResult(action.attemptId, action.resultId)
              : TaskOperationKeys.retryResult(action.attemptId, action.resultId);
            const observation = this.eventFromDecision(decision, {
              type: 'dispatch_requested', taskId: action.taskId,
              reason: 'explicit result decision released the authorized frontier',
            });
            // Only local durable writes here. Acceptance, continuation, queue,
            // application and observation either all commit or all roll back.
            this.deps.effectOutboxRepo.transaction(() => {
              this.deps.taskStateAuthority.reconcile({
                taskId: action.taskId, decisionId: decision.id, operationKey,
                actor: 'kernel-execution-runtime', reason: decision.reason,
                resolvedResult: { attemptId: action.attemptId, resultId: action.resultId },
                facts: () => {
                  if (action.type === 'retry_uncertified_result') {
                    this.lifecycle.transitionSubtask({ subtaskId: action.subtaskId, to: 'ready',
                      actor: 'kernel-execution-runtime', reason: 'explicit user retry authorized by Kernel',
                      changes: { error: null } });
                  }
                  this.deps.effectOutboxRepo.enqueue({
                    id: `result_continuation:${operationKey}`, decisionId: decision.id,
                    taskId: action.taskId, effectType: 'task_result_continuation',
                    payload: { action }, availableAt: new Date().toISOString(),
                  });
                  const task = this.deps.taskRuntimeService.findTask(action.taskId)!;
                  const scheduler = this.deps.conversationTaskSchedulerRepo;
                  if (scheduler && task.conversationId) {
                    const payload = scheduler.getQueuedPayload(task.id);
                    scheduler.enqueueTask(task.id, task.conversationId, new Date().toISOString(), {
                      ...(payload ?? {}), requestText: payload?.requestText ?? task.goal,
                      generationId: action.generationId, graphRevision: action.graphRevision,
                      workGraph: payload?.workGraph ?? null,
                      authorizedBindingsBySubtask: payload?.authorizedBindingsBySubtask ?? null,
                      workspaceId: task.workspaceId ?? null,
                      plannerSessionId: task.ownerPlannerSessionId ?? this.sessionId,
                      executionMode: 'follow-up', schedulingReason: 'explicit result decision',
                    });
                  }
                  return [`result:${action.resultId}`];
                },
              });
              this.deps.kernelWorkflowStore.markApplied(decision.id, observation, new Date().toISOString());
            });
            receipt = { taskId: action.taskId, affectedSubtaskIds: [action.subtaskId], cleanupAttemptIds: [] };
            return observation;
          }
          if (decision.action.type === 'authorize_workspace_delivery') {
            const action = decision.action;
            const graph = this.deps.workGraphRevisionRepo.findActive(action.taskId);
            const candidates = this.deps.publicationRepo
              .listAwaitingAcceptance(action.taskId, action.generationId);
            const expected = new Set(action.publicationIds);
            if (
              graph?.generationId !== action.generationId
              || graph.revision !== action.graphRevision
              || candidates.length !== expected.size
              || candidates.some(candidate => !expected.has(candidate.id))
            ) {
              controlError = '候选变更已变化，请刷新任务后重试。';
              return null;
            }
            authorizedPublicationIds = this.deps.publicationRepo.authorizeDelivery(
              action.publicationIds,
              new Date().toISOString(),
            );
            receipt = { taskId: action.taskId, affectedSubtaskIds: [], cleanupAttemptIds: [] };
            return this.eventFromDecision(decision, {
              type: 'dispatch_requested',
              taskId: action.taskId,
              reason: 'explicit acceptance released the candidate Workspace delivery',
            });
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
        'task_result_retry_requested',
      ],
      acceptedActions: [
        'cancel_task',
        'cancel_subtasks',
        'accept_partial_result',
        'accept_uncertified_result',
        'retry_uncertified_result',
        'authorize_workspace_delivery',
        'reject_request',
        'block_work',
        'no_op',
      ],
      taskId: event.taskId!,
    });
    await workflow.submit(event);
    if (controlError) throw new Error(controlError);
    if (!receipt) throw new Error('Task control decision produced no receipt');
    if (event.type === 'partial_result_acceptance_requested' || event.type === 'task_result_retry_requested') {
      if (!['succeeded', 'cancelled', 'failed'].includes(this.deps.taskRuntimeService.findTask(event.taskId!)?.status ?? '')) {
        await this.recoverDue(
          event.taskId!,
          authorizedPublicationIds > 0
            ? 'explicit acceptance released candidate Workspace delivery'
            : 'user result decision released publication or retry',
        );
      }
    }
    return receipt;
  }

  private async drainCancellation(taskId: string): Promise<void> {
    try {
      await this.attemptSupervisor.drain(taskId);
      await this.deps.cancellationCoordinator.recover(taskId);
      const task = this.deps.taskRuntimeService.findTask(taskId);
      if (task?.status === 'cancelled'
        && this.deps.cancellationCoordinator.completionBlockedReasons(taskId, null).length === 0) {
        // Admission alone is not completion: publish only after cleanup settles.
        this.appendExecutionTrace({
          phase: 'delivery',
          actor: 'runtime',
          kind: 'turn_cancelled',
          status: 'completed',
          title: 'Task cancellation completed',
          summary: 'Task cancellation and execution cleanup completed.',
          details: { taskId },
          eventKey: `${taskId}:cancelled`,
          taskId,
          traceStatus: 'cancelled',
        });
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

  private readonly resultContinuations = new Map<string, Promise<boolean>>();

  private resumeResultContinuations(taskId: string): Promise<boolean> {
    const running = this.resultContinuations.get(taskId);
    if (running) return running;
    const work = this.drainResultContinuations(taskId).finally(() => this.resultContinuations.delete(taskId));
    this.resultContinuations.set(taskId, work);
    return work;
  }

  private async drainResultContinuations(taskId: string): Promise<boolean> {
    const effects = (this.deps.effectOutboxRepo?.listByTaskAndType?.(taskId, 'task_result_continuation') ?? [])
      .filter(effect => effect.status !== 'sent');
    if (effects.length === 0) return true;
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const scheduler = this.deps.conversationTaskSchedulerRepo;
    if (!task || !['queued', 'running'].includes(task.status)) return false;
    if (!scheduler || !task.conversationId) return false;
    let slot = scheduler.getSlot(task.conversationId);
    if (slot.state === 'free') {
      // The existing account scheduler owns promotion when installed. A local
      // single-Task Session uses the same durable queue and reservation path.
      if (this.deps.onTaskQueued) {
        // Account runtimes normally wake from terminal-task callbacks or the
        // periodic recovery pass. An accepted result is neither terminal nor
        // an ordinary new submission, so it used to sit in `queued` until that
        // periodic pass. Ask the account scheduler to promote it immediately;
        // the callback starts the promoted Task asynchronously and the current
        // continuation drain remains the idempotent fallback.
        void this.deps.onTaskQueued?.(taskId);
        return false;
      }
      if (this.deps.onTaskTerminal) return false;
      if (scheduler.listSlots().some(item => item.activeTaskId !== null)) return false;
      scheduler.promoteNextQueued(task.conversationId, new Date().toISOString());
      slot = scheduler.getSlot(task.conversationId);
    }
    if (slot.activeTaskId !== taskId || slot.state !== 'occupied') return false;
    scheduler.markRunning(taskId, new Date().toISOString());
    for (const effect of effects) {
      const action = effect.payload.action as Extract<KernelDecision['action'],
        { type: 'accept_uncertified_result' | 'retry_uncertified_result' }>;
      const revision = this.deps.workGraphRevisionRepo.findActive(taskId);
      if (action.taskId !== taskId || revision?.generationId !== action.generationId
        || revision.revision !== action.graphRevision) return false;
      // Staging is idempotent by publication id and validates the current slot
      // before/after Git. Retrying this local effect does not re-run an Executor.
      if (effect.status === 'uncertain' || effect.status === 'failed') {
        this.deps.effectOutboxRepo.resolve(effect.id, 'retry', new Date().toISOString());
      }
      const delivered = await this.deps.effectOutboxRepo.deliver(effect.id, async () => {
        if (action.type === 'accept_uncertified_result') await this.deps.attemptRunner.stageAcceptedResult(action);
        return action.resultId;
      }, () => new Date().toISOString());
      if (delivered.status !== 'sent') return false;
      this.reconcileTaskState(taskId, { decisionId: effect.decisionId,
        operationKey: `result_started:${effect.id}`, reason: 'reserved result continuation started' });
    }
    return true;
  }

  /**
   * Retires internal Worktree execution directories that can no longer produce
   * a side effect. Never deletes a user Workspace and never removes a directory
   * while any publication, lease, dispatch, wake, replan or uncertain
   * application is still open.
   */
  async cleanupWorktreeExecutions(taskId?: string): Promise<WorktreeCleanupOutcome> {
    const service = this.worktreeCleanupService();
    if (!service) return { removed: [], retained: [], failures: [] };
    if (taskId) return service.cleanupTask(taskId);
    return service.cleanupTerminalTasks();
  }

  private worktreeCleanupService(): WorktreeExecutionCleanupService | null {
    const store = this.deps.workspaceStore;
    const bindings = this.deps.workspaceExecutionBindingRepo;
    if (!store || !bindings) return null;
    return new WorktreeExecutionCleanupService({
      workspaceStore: store,
      bindingRepo: bindings,
      subtaskRepo: this.deps.subtaskRepo,
      publicationReader: {
        hasUndecidedDelivery: (taskId, generationId) => (
          this.deps.publicationRepo.hasUndecidedDelivery(taskId, generationId)
        ),
      },
      // The coordinator exposes exactly the safe-shutdown residue categories
      // (dispatch, publication, leases, wakes, replans, uncertain applications).
      residueReader: {
        blockingReasons: (taskId, generationId) => (
          this.deps.cancellationCoordinator.completionBlockedReasons(taskId, generationId ?? null)
        ),
      },
      findTask: taskId => this.deps.taskRuntimeService.findTask(taskId),
      pruneManagedWorktrees: async (taskId, generationId) => {
        await new ManagedGitWorkspaceService(store).pruneMissingWorktrees({ taskId, generationId });
      },
      removeManagedRepository: async (taskId, generationId) => {
        const git = new ManagedGitWorkspaceService(store);
        await store.removeManagedRepositoryUri(
          pathToFileURL(git.repositoryPathFor({ taskId, generationId })).href,
        );
      },
      recordDiagnostic: input => this.appendExecutionTrace({
        phase: 'verification',
        actor: 'runtime',
        kind: input.kind,
        status: input.kind === 'cleanup_failed' ? 'failed' : 'blocked',
        title: 'Worktree execution directory cleanup',
        summary: input.reason,
        details: { taskId: input.taskId, generationId: input.generationId },
        eventKey: `${input.taskId}:${input.generationId}:${input.kind}`,
        taskId: input.taskId,
      }),
    });
  }

  async recoverDue(taskId: string, reason = 'durable workflow recovery'): Promise<boolean> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) return false;
    if (await this.resumeRemainingWork(taskId)) return true;
    const beforeStatus = task.status;
    const beforeUpdatedAt = task.updatedAt;
    if (!await this.resumeResultContinuations(taskId)) return false;
    await this.recoverLocalServiceOperations(taskId);
    await this.execute(this.prepareExecution({
      taskId,
      request: {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: task.status === 'needs_action' ? 'resume-blocked' : 'follow-up',
        origin: 'system',
        schedulingReason: reason,
      },
      recoveryOnly: true,
    }));
    const after = this.deps.taskRuntimeService.findTask(taskId);
    // A block may be stale: the facts can already prove the conclusion (for
    // example an accepted result whose later metadata correction failed).
    // Re-evaluate once so recovery converges instead of leaving a Task that has
    // nothing left to do at `needs_action`. Only a corrected *conclusion*
    // counts as recovery progress; re-deriving the same block is not progress
    // (otherwise a blocked Task would suppress every watchdog reminder).
    if (after?.status === 'needs_action' && this.shouldReconcileBlockedTask(after)) {
      try {
        const reconciliation = this.deps.taskStateAuthority.reconcile({
          taskId,
          decisionId: `recovery_reconcile:${taskId}:${after.stateVersion}`,
          operationKey: `recovery_reconcile:${taskId}:${after.stateVersion}`,
          actor: 'kernel-execution-runtime',
          reason: reason || 'durable recovery re-evaluated the block',
        });
        if (reconciliation?.applied && reconciliation.task.status !== after.status) return true;
      } catch {
        // A reconcile that cannot apply keeps the block; startup must continue.
      }
    }
    return after !== null
      && (after.status !== beforeStatus || after.updatedAt !== beforeUpdatedAt);
  }

  async recoverRetryWake(
    event: Extract<KernelEvent, { type: 'timer_tick' }>,
    reason = 'durable Retry Wake recovery',
  ): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(event.taskId ?? '');
    if (!task) return;
    await this.execute(this.prepareExecution({
      taskId: task.id,
      request: {
        userPrompt: task.goal,
        contextTaskId: task.id,
        executionMode: 'follow-up',
        origin: 'system',
        schedulingReason: reason,
      },
      recoveryOnly: true,
      initialEvent: event,
    }));
  }

  private retryWakeFact(wakeId: string | null | undefined): KernelRetryWakeFact | null {
    if (!wakeId) return null;
    const wake = this.deps.retryWakeRepo.findById(wakeId);
    return wake
      ? {
          wakeId: wake.wakeId,
          taskId: wake.taskId,
          subtaskId: wake.subtaskId,
          generationId: wake.generationId,
          sourceDecisionId: wake.sourceDecisionId,
          sourceAttemptId: wake.sourceAttemptId,
          configurationRevision: wake.configurationRevision,
          bindingFingerprint: wake.bindingFingerprint,
          resumeAt: wake.resumeAt,
          status: wake.status,
          timerEventId: wake.timerEventId,
        }
      : null;
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
      dependencyReadiness: dependencyReadinessFacts({
        taskId, generationId: activeRevision?.generationId ?? `generation_${taskId}_1`,
        subtasks, handoffs: persistedHandoffs, resultObjectRepo: this.deps.resultObjectRepo,
        workspaceRepository: this.deps.workspaceRepository, includeRecoverable: true,
      }) ?? [],
      supportsEvidenceTools: binding => this.deps.attemptRunner.supportsEvidenceTools(binding),
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
    const recoverySafety = deriveRecoverySafety(recoverySubtask
      ? recoverySubtask.requiredCapabilities
      : subtasks.filter(subtask => ['ready', 'blocked', 'awaiting_decision'].includes(subtask.status))
        .flatMap(subtask => subtask.requiredCapabilities));
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
      productionAuthorization: this.deps.productionAuthorization?.(),
      subtasks: subtasks.map(subtask => ({
        id: subtask.id,
        taskId: subtask.taskId,
        status: subtask.status,
        executorBindings: subtask.executorBindings,
      })),
      frontier,
      dependencyReadiness,
      resumeRecoveryCandidates: recoveryCandidates,
      upstreamInputResume: recoveryCandidates?.some(item => item.reason === 'upstream_input_restored')
        ? this.upstreamInputResumeFacts(taskId) : undefined,
      deliveryRecoveryPublicationIds: this.deps.publicationRepo.unfinishedDeliveries(taskId, activeRevision?.generationId ?? `generation_${taskId}_1`)
        .filter(item => this.deps.publicationRepo.delivery(item.id)?.status === 'failed').map(item => item.id),
      pendingRetrySubtaskIds: this.deps.retryWakeRepo?.findBlockingByTask?.(taskId).map(wake => wake.subtaskId) ?? [],
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
      // Durable repair budget facts: the Kernel authorizes the next service
      // repair round only when this count matches the requested ordinal.
      serviceRepairAttemptsBySubtask: serviceRepairRoundCounts(dispatchItems),
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
            const request = this.deps.generationReplanRepo.findLatestOpen(
              taskId,
              activeRevision.generationId,
            );
            return request ? {
              id: request.id,
              status: request.status as 'pending_quiescence' | 'planning' | 'submitted' | 'failed',
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

  private upstreamInputResumeFacts(taskId: string): Extract<KernelSnapshot, { type: 'dispatch' }>['upstreamInputResume'] {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const revision = this.deps.workGraphRevisionRepo.findActive(taskId);
    if (!task || !revision) return undefined;
    const blockers = task.dependencies.filter(item => item.status === 'waiting');
    // Only the exact startup-created orphan fence can be superseded by terminal
    // receipts. A user/manual/permission blocker is never inferred away.
    if (blockers.some(item => item.type !== 'manual'
      || item.description !== 'startup recovery found running work without authorized dispatch')) return undefined;
    if ((this.deps.kernelWorkflowStore.listRecoveryItems?.(taskId) ?? []).length > 0
      || (this.deps.kernelWorkflowStore.listRecoverableApplications?.(undefined, taskId) ?? []).length > 0) return undefined;
    const request = this.deps.generationReplanRepo.findLatestOpen(taskId, revision.generationId);
    if (!request) return { rejectedReplanRequestId: null };
    if (request.status !== 'submitted' || request.sourceRevision !== revision.revision
      || request.configurationRevision !== revision.configurationRevision) return undefined;
    const rejected = this.deps.kernelDecisionRepo?.findById(`decision_replan_event_${request.triggerDecisionId}`);
    const event = rejected?.event;
    if (rejected?.action !== 'request_clarification' || !rejected.reason.startsWith('unqualified context refs:')
      || event?.type !== 'plan_proposed' || event.proposalSource !== 'replan'
      || event.taskId !== taskId || event.proposal.task.taskId !== taskId
      || event.generationId !== revision.generationId || event.targetGraphRevision !== revision.revision + 1
      || event.configurationRevision !== revision.configurationRevision) return undefined;
    return { rejectedReplanRequestId: request.id };
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
      // no_op has no action target, but still belongs to this execution's Task.
      taskId: 'taskId' in action ? action.taskId : input.request.contextTaskId,
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
      if (!task) return null;
      // Replay-idempotent by design (2026-09-25 review fix 3): a first apply can
      // have moved the Task to `running` without landing its dispatch
      // observation. Returning early there would strand the Task, so the guard
      // only excludes terminal states; the observation event id is derived from
      // the Decision and is deduplicated by the Kernel inbox.
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
        return null;
      }
      const resumeRevision = this.deps.workGraphRevisionRepo.findActive(action.taskId);
      if (!resumeRevision || resumeRevision.generationId !== action.generationId || resumeRevision.revision !== action.graphRevision) return null;
      if (action.retireReplanRequestId) {
        this.deps.generationReplanRepo.retireRejectedProposal({
          id: action.retireReplanRequestId, taskId: action.taskId,
          generationId: action.generationId, sourceRevision: action.graphRevision,
          decisionId: decision.id, now: new Date().toISOString(),
        });
      }
      for (const publicationId of action.deliveryPublicationIds ?? []) {
        this.deps.publicationRepo.retryDelivery(publicationId, action.taskId, action.generationId, new Date().toISOString());
      }
      for (const subtaskId of action.subtaskIds) {
        const subtask = this.deps.subtaskRepo.findById(subtaskId);
        if (
          !subtask
          || subtask.taskId !== action.taskId
          || subtask.status === 'done'
          || subtask.status === 'cancelled'
        ) continue;
        if (subtask.status === 'blocked') {
          this.lifecycle.transitionSubtask({
            subtaskId: subtask.id,
            to: 'ready',
            actor: 'kernel-execution-runtime',
            reason: 'Kernel-authorized resume cleared the Subtask blocker',
            changes: { error: null },
          });
        }
      }
      this.reconcileTaskState(task.id, {
        decisionId: decision.id,
        operationKey: `resume:${decision.id}`,
        resumeAuthorized: true,
        reason: `Kernel-authorized resume after ${action.blockerCategory} blocker`,
        // The resume resolves the blockers that stopped the Task. Leaving them
        // `waiting` made a stale gate (for example the official-account login
        // check) outlive the resume and re-block the Task after it finished.
        facts: () => {
          const current = this.deps.taskRuntimeService.findTask(task.id);
          if (!current) return [];
          const cleared = current.dependencies.filter(dependency => (
            dependency.status === 'waiting'
            && (dependency.type === 'manual' || dependency.type.startsWith('kernel_'))
          ));
          if (cleared.length === 0) return [];
          this.deps.taskRuntimeService.updateTask(task.id, {
            dependencies: current.dependencies.filter(dependency => !cleared.includes(dependency)),
          });
          return cleared.map(dependency => `dependency:${dependency.type}:${dependency.createdAt}`);
        },
      });
      this.deps.callbacks.refreshRuntimeState();
      if (action.recovery) {
        const recoverySubtask = this.deps.subtaskRepo.findById(action.recovery.subtaskId);
        if (
          recoverySubtask?.status === 'blocked'
          || recoverySubtask?.status === 'running'
        ) {
          this.lifecycle.transitionSubtask({
            subtaskId: recoverySubtask.id,
            to: 'awaiting_decision',
            actor: 'kernel-execution-runtime',
            reason: 'Kernel authorized continuation from the persisted attempt',
            changes: { error: null },
          });
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
      // Service-repair events are submitted while the source Subtask is still
      // `done`. Reopen it only after Kernel authorization has been applied so
      // a crash before/while workflow submission cannot strand an
      // `awaiting_decision` node without a durable dispatch event. The
      // transition is idempotent across application recovery: a replay sees
      // `awaiting_decision` and proceeds to the same idempotent dispatch insert.
      for (const item of action.items) {
        if (item.attemptPayload?.protocol !== 'metawork:service-repair:v1') continue;
        const subtask = this.deps.subtaskRepo.findById(item.subtaskId);
        if (subtask?.taskId === action.taskId && subtask.status === 'done') {
          this.lifecycle.transitionSubtask({
            subtaskId: subtask.id,
            to: 'awaiting_decision',
            actor: 'kernel-execution-runtime',
            reason: 'Kernel authorized service repair continuation',
            changes: { error: '服务未就绪，已授权自动修复' },
          });
        }
      }
      this.reconcileTaskState(action.taskId, { decisionId: decision.id,
        operationKey: `dispatch_resume:${decision.id}`, resumeAuthorized: true,
        reason: 'Kernel authorized this runnable frontier' });
      const generationId = this.deps.workGraphRevisionRepo.findActive(action.taskId)?.generationId
        ?? `generation_${action.taskId}_1`;
      const executionBinding = await this.bindWorkspaceExecution(action.taskId, generationId);
      const executionBindingFingerprint = executionBinding
        ? ('bindingVersion' in executionBinding ? executionBinding.bindingFingerprint : workspaceExecutionBindingFingerprint(executionBinding))
        : null;
      const sourceEvent = this.deps.kernelWorkflowStore?.findEvent?.(decision.eventId);
      const retryWake = sourceEvent?.type === 'timer_tick' && sourceEvent.wakeKind === 'retry'
        ? this.deps.retryWakeRepo?.findById(sourceEvent.retry?.wakeId ?? '')
        : null;
      if (retryWake && sourceEvent?.type === 'timer_tick') {
        // Persist the continuation dispatch before clearing the blocker or
        // allowing AttemptSupervisor to claim the item. Replaying this call is
        // safe because insertBatch is idempotent by attempt identity.
        this.deps.dispatchItemRepo.insertBatch(
          decision as KernelDecision & {
            action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
          },
          {
            generationId,
            configurationRevision: decision.configurationRevision,
            executionBindingFingerprint,
            attempts: Object.fromEntries(action.items.map(item => [
              item.attemptId,
              {
                authorizedBinding: item.authorizedBinding,
                bindingFingerprint: item.bindingFingerprint,
              },
            ])),
          },
          new Date().toISOString(),
        );
        const task = this.deps.taskRuntimeService.findTask(action.taskId);
        if (task && (task.status === 'needs_action' || task.status === 'queued') && task.dependencies.every(dependency => (
          dependency.status !== 'waiting' || dependency.type === 'kernel_retry'
        ))) {
          this.reconcileTaskState(action.taskId, {
            decisionId: decision.id,
            operationKey: `retry_wake:${retryWake.wakeId}`,
            reason: `Retry Wake ${retryWake.wakeId} authorized continuation`,
          });
        }
        this.deps.retryWakeRepo.markConsumed(
          retryWake.wakeId,
          decision.id,
          new Date().toISOString(),
        );
      }
      for (const item of action.items) {
        if (item.attemptKind !== 'merge_repair') continue;
        const subtask = this.deps.subtaskRepo.findById(item.subtaskId);
        if (subtask?.taskId === action.taskId && subtask.status === 'blocked') {
          this.lifecycle.transitionSubtask({
            subtaskId: subtask.id,
            to: 'awaiting_decision',
            actor: 'kernel-execution-runtime',
            reason: 'recovering legacy blocked merge conflict',
            changes: { error: 'recovering legacy blocked merge conflict' },
          });
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
          executionBindingFingerprint,
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
      let failure: import('../core/kernel-failure.js').KernelFailure | undefined;
      const available = await this.deps.workUnitClaimService.probe(action.authorizedBinding).catch(error => {
        if (!(error instanceof ExecutorProbeError)) throw error;
        failure = error.failure;
        return false;
      });
      return this.eventFromDecision(decision, {
        type: 'capacity_signal', taskId: action.taskId, subtaskId: action.subtaskId,
        authorizedBinding: action.authorizedBinding,
        bindingFingerprint: action.bindingFingerprint,
        available,
        ...(failure ? { failure } : {}),
        cycleId: input.executionId,
        attemptKind: 'primary',
        attemptPayload: null,
      });
    }
    if (action.type === 'wait_for_capacity') {
      const activeSibling = this.deps.dispatchItemRepo.listByTask(action.taskId).some(item => (
        item.subtaskId !== action.subtaskId
        && ['pending_launch', 'launching', 'running', 'cancelling'].includes(item.status)
      ));
      const waitingReason = `Subtask ${action.subtaskId} is waiting for an available Executor slot`;
      this.appendExecutionTrace({
        phase: 'routing',
        actor: 'kernel',
        kind: 'execution_waiting_for_capacity',
        status: 'running',
        title: '等待执行资源',
        summary: activeSibling
          ? '当前子任务等待执行名额；其他独立子任务继续执行。'
          : '当前子任务等待执行名额；名额释放后自动继续。',
        details: {
          taskId: action.taskId,
          subtaskId: action.subtaskId,
          scope: 'subtask',
          activeSibling,
          wake: 'capacity_recheck',
        },
        eventKey: `${decision.id}:waiting_for_capacity`,
        taskId: action.taskId,
      });
      // Capacity is a normal scheduler wait. Keep the Task at its current
      // lifecycle when another branch is still active, so one unavailable
      // slot cannot present the whole Task as blocked. If this is the only
      // branch, retain the durable Task-level wait for the existing timer
      // wake and recovery path.
      if (!activeSibling) {
        await this.blockTaskInternal(
          action.taskId, waitingReason,
          input.finishExecution, 'kernel_capacity',
        );
      } else {
        this.recordTaskEvent(action.taskId, action.subtaskId, 'phase2_execution_waiting', waitingReason, {
          scope: 'subtask',
          activeSibling: true,
        });
        await input.finishExecution(['当前子任务等待执行名额，其他独立子任务继续执行。']);
      }
      return null;
    }
    if (action.type === 'wait_for_retry') {
      await this.waitForRetry(
        action.taskId,
        action.subtaskId,
        action.resumeAt,
        decision,
        action,
        input.finishExecution,
      );
      return null;
    }
    if (action.type === 'supersede_retry_wake') {
      this.deps.retryWakeRepo.markSuperseded(
        action.wakeId,
        new Date().toISOString(),
      );
      return null;
    }
    if (action.type === 'recover_retry_wake') {
      this.deps.retryWakeRepo.markRecoveryRequired(
        action.wakeId,
        new Date().toISOString(),
      );
      await this.blockTaskInternal(
        action.taskId,
        action.reason,
        input.finishExecution,
        'manual',
      );
      return null;
    }
    if (action.type === 'wait_for_partition') {
      await this.blockTaskInternal(
        action.taskId,
        // The user sees this reason: name the wait, not an internal lease id.
        `等待资源：同一 Workspace 的写入租约正被其他子任务占用（${action.conflictingLeaseIds.length} 个租约），释放后继续执行。`,
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
          this.lifecycle.transitionSubtask({
            subtaskId: subtask.id,
            to: recoveryStatus,
            actor: 'kernel-execution-runtime',
            reason: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
            changes: {
              error: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
            },
          });
        }
        if (task.status === 'needs_action' || task.status === 'queued') {
          this.reconcileTaskState(task.id, {
            decisionId: decision.id,
            operationKey: `workspace_recovery:${decision.id}`,
            reason: `workspace recovery for ${action.workspaceId}`,
          });
        }
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
        this.lifecycle.transitionSubtask({
          subtaskId: subtask.id,
          to: 'ready',
          actor: 'kernel-execution-runtime',
          reason: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
          changes: {
            error: `recovering workspace ${action.workspaceId} from checkpoint ${action.checkpointId ?? 'latest'}`,
          },
        });
      }
      if (task.status === 'needs_action' || task.status === 'queued') {
        this.reconcileTaskState(task.id, {
          decisionId: decision.id,
          operationKey: `workspace_recovery:${decision.id}`,
          reason: `recovering workspace ${action.workspaceId}`,
        });
      }
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested', taskId: action.taskId,
        reason: `recover persistent workspace ${action.workspaceId}`,
      });
    }
    if (action.type === 'block_work') {
      if (
        action.subtaskId
        && (this.deps.subtaskRepo.findById(action.subtaskId)?.status === 'ready'
          || (!action.preserveSubtaskState && this.deps.subtaskRepo.findById(action.subtaskId)?.status === 'awaiting_decision'))
      ) {
        this.lifecycle.transitionSubtask({
          subtaskId: action.subtaskId,
          to: 'blocked',
          actor: 'kernel-execution-runtime',
          reason: decision.reason,
          changes: { error: decision.reason },
        });
      }
      // Result-first gate model: a blocked task with a safe result still
      // delivers that result to the user (marked as unverified) — content
      // checks hold downstream flow, never user delivery.
      this.deliverSafeResultOnBlock(action.taskId, decision.reason);
      // A local blocker must not freeze sibling attempts or their completion.
      // The next Kernel dispatch evaluates the remaining independent frontier.
      if (!action.subtaskId) {
        await this.blockTaskInternal(
          action.taskId,
          decision.reason,
          input.finishExecution,
          action.blockerKind === 'system' ? 'kernel_anomaly' : 'manual',
        );
      }
      this.appendExecutionTrace({
        phase: 'verification',
        actor: 'kernel',
        kind: 'execution_blocked',
        status: 'blocked',
        title: 'Execution needs attention',
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
      return action.subtaskId ? this.eventFromDecision(decision, {
        type: 'dispatch_requested', taskId: action.taskId,
        reason: 'Subtask blocked; evaluate independent work',
      }) : null;
    }
    if (action.type === 'await_user_decision') {
      const subtask = this.deps.subtaskRepo.findById(action.subtaskId);
      if (subtask && !['done', 'cancelled'].includes(subtask.status)) {
        this.lifecycle.transitionSubtask({
          subtaskId: subtask.id,
          to: 'awaiting_decision',
          actor: 'kernel-execution-runtime',
          reason: decision.reason,
          changes: { error: '结果已生成，等待用户选择接受并交付或重新执行' },
        });
      }
      this.deps.callbacks.appendOutput(
        '',
        '',
        '结果已安全保存，完成验收待处理。请选择接受并交付或重新执行。',
      );
      // The uncertified result is a durable pending action: the authority turns
      // it into `needs_action` (or keeps `running` while a sibling continues).
      this.reconcileTaskState(action.taskId, {
        decisionId: decision.id,
        operationKey: `await_user_decision:${decision.id}`,
        reason: decision.reason,
      });
      this.deps.callbacks.refreshRuntimeState();
      return this.eventFromDecision(decision, {
        type: 'dispatch_requested', taskId: action.taskId,
        reason: 'Result awaits a user decision; evaluate independent work',
      });
    }
    if (action.type === 'park_for_replan') {
      const task = this.deps.taskRuntimeService.findTask(action.taskId);
      if (task && task.status !== 'needs_action' && task.status !== 'running') {
        this.reconcileTaskState(task.id, {
          decisionId: decision.id,
          operationKey: `replan_park:${decision.id}`,
          reason: decision.reason,
        });
      }
      await input.finishExecution([decision.reason]);
      return null;
    }
    if (action.type === 'complete_task') {
      const effectId = `effect_${decision.id}_task_completion`;
      if (
        this.deps.taskRuntimeService.findTask(action.taskId)?.status === 'succeeded'
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
        await this.blockTaskInternal(
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
      // Terminal Task: retire the internal Worktree execution directory when no
      // residue can still produce a side effect.
      await this.cleanupWorktreeExecutions(action.taskId);
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
    if (action.type === 'request_replan' || action.type === 'schedule_replan') {
      // Durable Replan Job boundary (2026-09-25 convergence plan §5). Applying
      // this decision only has to make the Job durably schedulable; the Planner
      // turn is owned by the account-scoped Planner Worker. No foreground
      // Conversation, TUI or Web connection is required, so the application is
      // never left `uncertain` by a missing Planner callback.
      const jobId = action.type === 'schedule_replan'
        ? action.replanJobId
        : this.deps.generationReplanRepo.findByGeneration(
            action.taskId,
            action.generationId,
            action.sourceRevision,
          )?.id;
      if (!jobId) throw new Error('generation replan job is missing for scheduling');
      const token = `quiescence_${decision.id}`;
      if (!this.deps.generationReplanRepo.scheduleForPlanner(
        jobId,
        token,
        new Date().toISOString(),
      )) {
        throw new Error(`generation replan job could not be durably scheduled: ${jobId}`);
      }
      return null;
    }
    if (action.type === 'request_merge_replan') {
      const event = await this.deps.callbacks.requestMergeReplan(
        decision as KernelDecision & {
          action: Extract<KernelDecision['action'], { type: 'request_merge_replan' }>;
        },
      );
      if (!event) return null;
      const now = new Date().toISOString();
      this.deps.publicationRepo.incrementConflictReplan(action.publicationId, now);
      this.deps.publicationRepo.markParkedForConflictReplan(action.publicationId, now);
      return event;
    }
    if (action.type === 'defer_task_plan_for_availability') {
      const request = this.deps.generationReplanRepo.findByGeneration(
        action.taskId,
        action.proposalEvent.generationId,
        action.proposalEvent.targetGraphRevision - 1,
      );
      if (!request) throw new Error('generation replan request is missing for availability deferral');
      // Idempotent replay: a previous attempt may already have persisted the
      // deferral without landing the Task block. Skipping the block there would
      // let the Kernel record the application as applied while the Task is
      // still running (2026-09-25 review fix).
      const alreadyDeferred = request.status === 'waiting_for_availability';
      if (!alreadyDeferred && !this.deps.generationReplanRepo.deferForAvailability(
        request.id,
        action.proposalEvent,
        action.explanation,
        Object.values(action.authorizedBindingsBySubtask).flat(),
        new Date().toISOString(),
      )) {
        // The Job moved on without this deferral, so no Task blocker is
        // authorized by this Decision.
        return null;
      }
      await this.blockTaskInternal(
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
        conversationGit: Boolean(this.deps.conversationWorktrees),
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
    const binding = await this.bindWorkspaceExecution(item.taskId, item.generationId);
    if (binding) {
      request = { ...request, workspacePath: 'bindingVersion' in binding ? binding.executionRoot : binding.canonicalPath };
    }
    if (!request.workspacePath && this.deps.resolveWorkspacePath) {
      // Recovery/timer requests do not carry the conversation workspace;
      // resolve it from the task so continuation attempts execute against
      // the real source instead of the workspace-store fallback (P0-5).
      const resolved = await this.deps.resolveWorkspacePath(item.taskId);
      if (resolved) {
        request = { ...request, workspacePath: resolved };
      }
    }
    if (!request.workspacePath) {
      throw new Error(`attempt ${item.attemptId} has no workspace source: dispatch payload is missing its workspacePath`);
    }
    const sourceTask = this.deps.taskRuntimeService.findTask(item.taskId);
    if (this.deps.preflightWorkspacePath) {
      request = { ...request, workspacePath: await this.deps.preflightWorkspacePath(request.workspacePath!) };
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
    const resumedFromBlocked = task.status === 'needs_action';
    for (const resource of input.request.newlyProvidedResources ?? []) {
      this.deps.taskRuntimeService.attachResource(task.id, resource);
    }
    // The slot is already held here, so the authority concludes `running` for a
    // Task with runnable work and `queued`/`needs_action` otherwise.
    this.reconcileTaskState(task.id, {
      decisionId: item.decisionId,
      operationKey: `dispatch_admitted:${item.attemptId}`,
      reason: 'authorized attempt dispatch entered execution',
    });
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
    if (resumedFromBlocked) {
      this.appendExecutionTrace({
        phase: 'execution',
        actor: 'kernel',
        kind: 'execution_resumed',
        status: 'running',
        title: 'Task resumed execution',
        summary: `容量已恢复，已恢复 ${display.executorDisplayName} 执行。`,
        details: {
          taskId: item.taskId,
          attemptId: item.attemptId,
          recoveryMode: item.recoveryMode,
          ...bindingDetails,
          ...executionEventDetails({
            display,
            step: {
              stepKey: 'execution_resumed',
              stepLabel: `已恢复执行：${display.executorDisplayName}`,
            },
            startedAt: new Date().toISOString(),
          }),
        },
        eventKey: `${item.attemptId}:execution_resumed`,
        taskId: item.taskId,
      });
    }
    this.appendExecutionTrace({
      phase: 'execution',
      actor: 'kernel',
      kind: 'executor_dispatch_started',
      status: 'running',
      title: 'Executor dispatch started',
      summary: `Kernel started ${display.executorDisplayName} for "${subtask.title}".`,
      details: {
        taskId: item.taskId,
        attemptId: item.attemptId,
        attemptKind: item.attemptKind,
        recoveryMode: item.recoveryMode,
        subtaskGoal: subtask.goal,
        deliveryKind: subtask.deliveryKind,
        fileOutputs: subtask.fileOutputs,
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
        fileOutputs: subtask.fileOutputs,
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
        display.executorDisplayName,
      ),
    );

    const startedAtMs = Date.now();
    let lastProgressAtMs = startedAtMs;
    let lastProgressKind = 'dispatch_started';
    const operationHealthById = new Map<string, import('../executor/operation-activity-monitor.js').OperationHealth>();
    let lastActivityAtMs = startedAtMs;
    const currentOperationHealth = () => [...operationHealthById.values()]
      .sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt))[0] ?? null;
    let progressSequence = 0;
    const onProgress = (event: ExecutorProgressEvent, executor: ExecutorAdapter): void => {
      input.progressTracker.onProgress(event, executor);
      const safeText = formatExecutorProgress(event.text);
      if (!safeText) return;
      if (event.operationHealth) {
        const observation = event.operationHealth;
        if (observation.state === 'active') operationHealthById.delete(observation.operationId);
        else operationHealthById.set(observation.operationId, observation);
        lastActivityAtMs = Math.max(lastActivityAtMs, Date.parse(observation.lastActivityAt));
        if (observation.lastProgressAt) lastProgressAtMs = Math.max(lastProgressAtMs, Date.parse(observation.lastProgressAt));
      } else { lastProgressAtMs = Date.now(); lastActivityAtMs = lastProgressAtMs; lastProgressKind = event.kind; }
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
          operationHealth: currentOperationHealth(),
          ...(event.operationHealth ? { operationObservation: event.operationHealth } : {}),
          lastActivityAt: new Date(lastActivityAtMs).toISOString(),
          lastProgressAt: new Date(lastProgressAtMs).toISOString(),
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
      this.deps.callbacks.refreshRuntimeState();
    };
    const heartbeatMs = this.deps.executionTraceHeartbeatMs
      ?? DEFAULT_EXECUTION_TRACE_HEARTBEAT_MS;
    let heartbeatSequence = 0;
    const heartbeat = heartbeatMs > 0
      ? setInterval(() => {
          const nowMs = Date.now();
          if (nowMs - lastProgressAtMs < heartbeatMs) return;
          const heartbeatAt = new Date(nowMs).toISOString();
          this.deps.attemptRuntimeRepo?.touch(item.attemptId, heartbeatAt);
          this.deps.dispatchItemRepo.touch?.(item.attemptId, heartbeatAt);
          heartbeatSequence += 1;
          this.appendExecutionTrace({
            phase: 'execution',
            actor: 'runtime',
            kind: 'executor_heartbeat',
            status: 'running',
            title: `Execution awaiting new activity: ${subtask.title}`,
            summary: 'Execution has not ended; this presentation heartbeat is not evidence of work progress.',
            details: {
              taskId: item.taskId,
              attemptId: item.attemptId,
              elapsedMs: nowMs - startedAtMs,
              silentForMs: nowMs - lastProgressAtMs,
              lastProgressAt: new Date(lastProgressAtMs).toISOString(),
              lastProgressKind,
              heartbeatSequence,
              activityState: 'presentation_heartbeat',
              watchdogAuthority: false,
              operationHealth: currentOperationHealth(),
              lastActivityAt: new Date(lastActivityAtMs).toISOString(),
              ...bindingDetails,
              ...executionEventDetails({
                display,
                step: {
                  stepKey: 'executor_waiting',
                  stepLabel: `尚未结束，等待新进展：${subtask.title}`,
                  progress: null,
                },
                startedAt: dispatchStartedAt,
              }),
            },
            eventKey: `${item.attemptId}:heartbeat:${heartbeatSequence}`,
            taskId: item.taskId,
          });
          this.deps.callbacks.refreshRuntimeState?.();
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
            // The correction commits into the same authorized Workspace as the
            // attempt it corrects. Without it the runner fell back to the
            // account-wide `sourceRoot` (the internal workspace store), which
            // then tried to import the store into itself.
            ...(request.workspacePath ? { sourceRoot: request.workspacePath } : {}),
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
            sourceRoot: request.workspacePath,
            queryId: request.queryId,
            onProgress,
          });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.deps.callbacks.clearRunningExecutorName(item.taskId, item.attemptId);
    }
    this.appendExecutorOutcomeTrace(item, outcome);

    if (outcome.outcome === 'executor_unavailable') {
      return this.eventFromDispatchItem(item, {
        type: 'capacity_signal', authorizedBinding: item.authorizedBinding,
        bindingFingerprint: item.bindingFingerprint, available: false,
        failure: outcome.failure, cycleId: input.executionId,
        attemptKind: item.attemptKind, attemptPayload: item.attemptPayload,
      });
    }
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
    if (
      item.attemptKind !== 'contract_correction'
      && outcome.outcome === 'completed'
      && outcome.resultId
      && this.shouldDeliverCompletedResultInline(item, subtask)
    ) {
      // Report results and zero-change in-place edits do not create a
      // Workspace publication. Without this handoff the Task can become
      // `succeeded` while the Conversation only receives the generic
      // "completed" summary and loses the Executor's actual stdout/result.
      this.deps.callbacks.recordResultDelivery({
        resultId: outcome.resultId,
        content: outcome.output,
        completeness: 'complete',
        certification: 'certified',
      });
      this.deps.callbacks.appendOutput(
        this.deps.presentation.formatExecutorFinalResult({
          executorName: outcome.executorName,
          taskId: item.taskId,
          subtaskId: item.subtaskId,
          output: outcome.output,
        }),
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

  private shouldDeliverCompletedResultInline(
    item: KernelDispatchItemRecord,
    subtask: Subtask,
  ): boolean {
    if (subtask.deliveryKind === 'report') return true;
    // In-place edit attempts have no publication worker. A zero-delta edit is
    // therefore a result-only operation (for example, run an already updated
    // script and show stdout) and must use the inline result channel.
    if (item.attemptKind === 'merge_repair') return false;
    const runtime = this.deps.attemptRuntimeRepo?.find(item.attemptId);
    const changed = runtime?.workspaceDelta && typeof runtime.workspaceDelta === 'object'
      ? (runtime.workspaceDelta as { changed?: unknown }).changed
      : undefined;
    return !Array.isArray(changed) || changed.length === 0;
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
    const structured = error && typeof error === 'object' ? error as {
      code?: unknown; stage?: unknown; retryable?: unknown; userAction?: unknown;
    } : {};
    const workspaceSourceMissing = /no workspace source|missing its workspacePath/iu.test(summary);
    const code = typeof structured.code === 'string'
      ? structured.code
      : workspaceSourceMissing ? 'workspace_binding_missing' : 'dispatch_launch_failed';
    const isPreflight = structured.stage === 'workspace_preflight' || code.startsWith('workspace_');
    return this.eventFromDispatchItem(item, {
      type: 'execution_outcome',
      terminalKind: 'failed',
      authorizedBinding: item.authorizedBinding,
      bindingFingerprint: item.bindingFingerprint,
      attemptKind: item.attemptKind,
      sourceAttemptId: item.sourceAttemptId,
      failure: {
        kind: isPreflight ? 'configuration' : 'infrastructure',
        scope: isPreflight ? 'task' : 'attempt',
        code,
        summary,
        ...(isPreflight ? {
          label: 'Workspace 配置无效',
          stage: 'workspace_preflight',
          retryable: structured.retryable === true,
          attemptStarted: false,
          externalSideEffect: false,
          userAction: typeof structured.userAction === 'string'
            ? structured.userAction
            : '请选择具体项目目录后重新提交请求。',
        } : {}),
      },
    });
  }


  prepareExecution(input: KernelExecutionRuntimeInput): PreparedKernelExecutionInput {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    if (!task) throw new Error(`task not found: ${input.taskId}`);
    const graph = this.deps.workGraphRuntimeService.apply({
        conversationGit: Boolean(this.deps.conversationWorktrees),
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
    if (!await this.resumeResultContinuations(taskId)) return;
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
          expectedGenerationId: request.expectedGenerationId ?? this.deps.workGraphRevisionRepo.findActive(taskId)?.generationId,
          expectedGraphRevision: request.expectedGraphRevision ?? this.deps.workGraphRevisionRepo.findActive(taskId)?.revision,
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
                  this.deps.taskRuntimeService.findTask(taskId)?.stateDetail.reason.code,
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
          task: { id: task.id, status: this.deps.taskRuntimeService.findTask(task.id)?.status ?? task.status },
          wakeAuthorized: this.isKernelWakeAuthorized(this.deps.taskRuntimeService.findTask(task.id) ?? task, event.wakeKind),
          capacityBlockedAt: null,
          recheckAfterMs: 0,
          capacityBindings: [],
          nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
          executorStatuses: stableFacts.executorStatuses,
          defaultResourceGrant: defaultResourceGrant(task.id, `generation_${task.id}_1`, event.subtaskId ?? 'pending'),
          retryWake: this.retryWakeFact(event.retry?.wakeId),
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
      : event.type === 'recovery_required_observed' ? {
          schemaVersion: 5,
          type: 'recovery_required',
          task: { id: task.id, status: task.status },
          recoveryItemId: event.recoveryItemId,
          reason: event.reason,
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
      productionAuthorization: this.deps.productionAuthorization,
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
        'recovery_required_observed',
      ],
      acceptedActions: [
        'resume_task', 'dispatch_batch', 'probe_capacity', 'wait_for_capacity', 'wait_for_retry',
        'supersede_retry_wake', 'recover_retry_wake',
        'block_work', 'await_user_decision', 'park_for_replan', 'complete_task', 'request_replan', 'schedule_replan',
        'queue_generation_replan',
        'request_merge_replan',
        'authorize_task_plan', 'defer_task_plan_for_availability', 'no_op',
        'wait_for_partition', 'recover_workspace_attempt', 'resolve_recovery',
      ],
      taskId,
    });
    this.attemptSupervisor.recover(taskId, supervisorContext);
    await this.recoverExpiredAttempts(workflow, attemptFacts);
    if (input.initialEvent) {
      await workflow.submit(input.initialEvent);
    } else if (input.recoveryOnly) {
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
    // Cleanup can remove the last completion blocker after the publication
    // event was already consumed (including across a Server restart). Ask the
    // same Kernel to reevaluate completion; never write Task.done here.
    if (this.deps.taskRuntimeService.findTask(taskId)?.status === 'running') {
      const subtasks = this.deps.subtaskRepo.listActiveByTask(taskId);
      if (subtasks.length > 0 && subtasks.every(subtask => subtask.status === 'done')
        && this.deps.cancellationCoordinator.completionBlockedReasons(taskId, null).length === 0) {
        await workflow.submit({
          schemaVersion: 5, configurationRevision, type: 'dispatch_requested',
          id: `settled_dispatch_${executionId}`, correlationId: executionId, causationId: null,
          occurredAt: new Date().toISOString(), sessionId: this.sessionId, taskId,
          reason: 'terminal cleanup released completion blockers',
        });
      }
    }
    // A Task can reach a terminal conclusion through the state authority (for
    // example a delivered publication satisfies the last requirement) without a
    // separate `complete_task` decision. Retiring the internal Worktree
    // execution directory belongs to that same work chain, so it is awaited
    // here instead of racing the authority.
    if (TERMINAL_TASK_STATUSES.includes(
      this.deps.taskRuntimeService.findTask(taskId)?.status as 'succeeded',
    )) {
      await this.cleanupWorktreeExecutions(taskId);
    }
  }

  private convergeWorkspaceDelivery(taskId:string, identity:string, resumeAuthorized=false):void {
    let task=this.deps.taskRuntimeService.findTask(taskId);
    const staleSystemBlock=task?.status==='needs_action' && task.stateDetail.pendingActions.length===0
      && ['no_authorized_driver','system_anomaly'].includes(task.stateDetail.reason.code);
    for(let step=0;step<3;step++) {
      const before=task?.status;
      this.reconcileTaskState(taskId,{decisionId:identity,operationKey:`${identity}:${step}`,
        reason:'Workspace delivery facts updated',resumeAuthorized:resumeAuthorized||staleSystemBlock});
      task=this.deps.taskRuntimeService.findTask(taskId);
      if(before===task?.status)break;
    }
  }

  private registerMergedWorkspace(job:import('../workspace/workspace-git-contracts.js').WorkspaceMergeJob,generationId:string):void {
    const conversations=this.deps.conversationWorktrees!;
    const root=conversations.repo.root(job.workspaceId)!;
    const artifacts=this.deps.userArtifactPublication?.taskArtifactRepo;
    if(!artifacts)return;
    const now=new Date().toISOString();
    for(const file of conversations.repo.files(job.jobId)) {
      artifacts.publicFiles.invalidatePath(root.accountId,resolve(root.userRoot,file.relativePath));
      if(!file.after) { artifacts.publicFiles.remove(root.accountId,job.taskId,file.relativePath);continue; }
      artifacts.publicFiles.record({accountId:root.accountId,taskId:job.taskId,relativePath:file.relativePath,
        generationId,subtaskId:null,publicationId:job.jobId,publishedPath:resolve(root.userRoot,file.relativePath),
        contentHash:`sha256:${file.afterSha256}`,updatedAt:now});
    }
    for(const artifact of artifacts.listByTask(job.taskId)) {
      if(artifact.generationId!==generationId)continue;
      const file=conversations.repo.files(job.jobId).find(f=>f.relativePath===artifact.relativePath);
      if(file?.after && file.afterSha256===artifact.contentHash.replace(/^sha256:/u,''))
        artifacts.markPublished(artifact.artifactId,resolve(root.userRoot,artifact.relativePath),now);
    }
  }

  private async finishDeliveredWorkspaceTask(taskId:string,identity:string):Promise<void> {
    const task=this.deps.taskRuntimeService.findTask(taskId);
    if(task?.status!=='succeeded')return;
    const revision=this.deps.workGraphRevisionRepo.findActive(taskId)??this.deps.workGraphRevisionRepo.findLatest(taskId);
    if(!revision?.authorizedDecisionId)return;
    // Outbox rows must reference a real originating decision, never a synthetic observation ID.
    await this.completeTask({taskId,decisionId:revision.authorizedDecisionId,executionId:identity,
      request:{userPrompt:task.goal,contextTaskId:task.id,executionMode:'fresh',origin:'system'},
      subtasks:this.deps.subtaskRepo.listByTask(taskId).filter(subtask=>subtask.generationId===revision.generationId&&subtask.status==='done'),
      revisionCompletion:{revision:revision.revision,completionKind:'full'},finishExecution:async()=>{}});
  }

  /** Project only this durable delivery identity; never re-run business work. */
  async onWorkspaceMergeChanged(job: import('../workspace/workspace-git-contracts.js').WorkspaceMergeJob): Promise<void> {
    const conversations = this.deps.conversationWorktrees;
    const current = conversations?.repo.job(job.jobId);
    const revision = this.deps.workGraphRevisionRepo.findActive(job.taskId)
      ?? this.deps.workGraphRevisionRepo.findLatest(job.taskId);
    const binding = revision && conversations?.repo.binding(job.taskId, revision.generationId);
    if (!current || !binding || binding.workspaceId !== current.workspaceId
      || conversations?.repo.summary(job.taskId, revision!.generationId)?.jobId !== current.jobId) return;
    let task = this.deps.taskRuntimeService.findTask(job.taskId);
    const pending = task?.stateDetail.pendingActions ?? [];
    const resumeAuthorized = task?.status === 'needs_action' && pending.length > 0
      && pending.every(action => action.workspaceMerge?.jobId === current.jobId)
      && !['conflicted', 'recovering'].includes(current.state);
    if(current.state==='delivered') this.registerMergedWorkspace(current,revision!.generationId);
    this.convergeWorkspaceDelivery(job.taskId,`workspace_merge:${current.jobId}:${current.rowVersion}`,resumeAuthorized);
    if(current.state==='delivered') {
      await this.startRequestedPublishedService(job.taskId);
      this.convergeWorkspaceDelivery(job.taskId,`workspace_merge_service:${current.jobId}:${current.rowVersion}`,resumeAuthorized);
      await this.finishDeliveredWorkspaceTask(job.taskId,`workspace_merge:${current.jobId}`);
    }
    task=this.deps.taskRuntimeService.findTask(job.taskId);
    this.deps.callbacks.refreshRuntimeState();
    if (task && TERMINAL_TASK_STATUSES.includes(task.status as 'succeeded')) {
      await this.deps.onTaskTerminal?.(job.taskId);
    }
  }

  private async drainPublications(input: {
    taskId: string;
    executionId: string;
    workflow: KernelWorkflow;
  }): Promise<void> {
    while (true) {
      const activeRevision = this.deps.workGraphRevisionRepo.findActive(input.taskId)
        ?? this.deps.workGraphRevisionRepo.findLatest(input.taskId);
      if (!activeRevision) return;
      const conversations = this.deps.conversationWorktrees;
      const binding = conversations?.repo.binding(input.taskId, activeRevision.generationId);
      if (binding && conversations && this.deps.workspaceMergeWorker) {
        const subtasks = this.deps.subtaskRepo.listByTask(input.taskId).filter(item=>item.graphRevision===activeRevision.revision);
        if (!subtasks.length || !subtasks.every(item => item.status === 'done' || item.status === 'cancelled')) return;
        const task=this.deps.taskRuntimeService.findTask(input.taskId)!;
        const held=task.workspaceDeliveryPolicy==='await_acceptance';
        const sealed = await conversations.sealTask(input.taskId, activeRevision.generationId,held);
        if (sealed.changeId && !held) conversations.repo.enqueue(sealed.changeId, `task_delivery:${sealed.changeId}`);
        else if(!sealed.hasChanges) conversations.markNoChanges(input.taskId, activeRevision.generationId);
        await this.deps.workspaceMergeWorker.drain(binding.workspaceId);
        this.convergeWorkspaceDelivery(input.taskId,`workspace_delivery:${input.taskId}:${activeRevision.generationId}:${conversations.repo.summary(input.taskId,activeRevision.generationId)?.rowVersion??'none'}`);
        if (held || !sealed.hasChanges || conversations.repo.summary(input.taskId,activeRevision.generationId)?.state === 'delivered') {
          if (!held) await this.startRequestedPublishedService(input.taskId, input.workflow);
          this.convergeWorkspaceDelivery(input.taskId,`workspace_service_settled:${input.taskId}:${activeRevision.generationId}`);
          await this.finishDeliveredWorkspaceTask(input.taskId,`workspace_settled:${input.taskId}:${activeRevision.generationId}`);
        }
        return;
      }
      const outcomes = await this.deps.publicationWorker.drain(
        input.taskId,
        activeRevision.generationId,
      );
      if (outcomes.length === 0) {
        await this.startRequestedPublishedService(input.taskId, input.workflow);
        return;
      }
      let integrated = false;
      for (const outcome of outcomes) {
        if (outcome.type === 'conflicted') {
          await input.workflow.submit(outcome.event);
          await this.attemptSupervisor.drain(input.taskId);
          return;
        }
        if (outcome.type === 'cancelled') continue;
        if (outcome.type === 'awaiting_acceptance') {
          // The candidate change set is ready but the target Workspace must stay
          // untouched until the user accepts it. The Task converges to
          // `needs_action` with the durable acceptance action; re-draining would
          // just rediscover the same undecided candidate.
          this.reconcileTaskState(outcome.taskId, {
            decisionId: `publication_acceptance_${outcome.publicationId}`,
            operationKey: `publication_acceptance:${outcome.publicationId}`,
            reason: 'candidate Workspace changes await explicit acceptance',
          });
          continue;
        }
        if (outcome.type === 'delivery_failed') {
          // A failed delivery is a durable operation result: record it and let
          // the authority expose the explicit delivery recovery action.
          this.recordOperationResult({
            taskId: outcome.taskId,
            operationKey: `delivery:${outcome.publicationId}`,
            operationKind: 'delivery',
            outcome: 'definite_failure',
            reasonCode: 'delivery_failed',
            message: '文件交付失败。',
            evidenceRefs: [`publication:${outcome.publicationId}`],
          });
          this.reconcileTaskState(outcome.taskId, {
            decisionId: `publication_delivery_${outcome.publicationId}`,
            operationKey: `publication_delivery:${outcome.publicationId}`,
            reason: 'publication delivery failed',
          });
          // Delivered code plus failed file delivery is exactly the remaining
          // work protocol; retrying it is internal, not a user command.
          await this.attemptAutomaticRemainingWork(outcome.taskId);
          continue;
        }
        integrated = true;
        // A successful delivery is a durable operation result, so the Task
        // conclusion can be derived from it (design §5.1: 操作统一上报事实).
        if (this.deps.publicationRepo.delivery(outcome.publicationId)?.status === 'succeeded') {
          this.recordOperationResult({
            taskId: outcome.taskId,
            operationKey: `delivery:${outcome.publicationId}`,
            operationKind: 'delivery',
            outcome: 'success',
            reasonCode: null,
            message: '文件交付成功。',
            evidenceRefs: [`publication:${outcome.publicationId}`],
          });
        }
        this.projectIntegratedPublication(outcome);
        await this.startRequestedPublishedService(outcome.taskId, input.workflow);
        // Integrated publication and successful delivery are durable facts; the
        // authority recomputes the conclusion from them.
        this.reconcileTaskState(outcome.taskId, {
          decisionId: `publication_integrated_${outcome.publicationId}`,
          operationKey: `publication_integrated:${outcome.publicationId}`,
          reason: 'publication integrated',
        });
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
      // The drain changed a publication/delivery fact (integrated, or a delivery
      // that was retried here), so the Task conclusion must be re-derived from
      // it in the same work chain (design §5.1: 统一操作收尾). A drain that
      // changed nothing leaves the surrounding decision to conclude.
      if (outcomes.length > 0) {
        this.reconcileTaskState(input.taskId, {
          decisionId: `publication_drain:${input.executionId}`,
          operationKey: `publication_drain:${input.executionId}:${this.deps.taskRuntimeService.findTask(input.taskId)?.stateVersion}`,
          reason: 'publication drain converged',
        });
      }
      // Only an integration can unblock the next publication in the serial
      // ordering. A candidate awaiting acceptance, a cancelled publication and a
      // settled delivery failure are stable states that an explicit user action
      // re-drives; re-draining them here would spin forever on the same row.
      if (!integrated) return;
    }
  }

  private async startRequestedPublishedService(
    taskId: string,
    workflow?: KernelWorkflow,
  ): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const manager = this.deps.managedLocalServices;
    if (!task?.startServiceAfterPublish) return;
    // A terminal Task keeps its conclusion. The repair loop below never lets a
    // Task reach that state while an authorized repair round remains, so this
    // fence only stops historical or cancelled work.
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return;
    const resourceTaskId = task.retryOfTaskId ?? taskId;
    const inPlaceWorkspace = task.executionMode === 'in_place';
    if (!manager || (!inPlaceWorkspace && !await manager.isPublished(resourceTaskId))) {
      if (this.deps.subtaskRepo.listActiveByTask(taskId).every(subtask => subtask.status === 'done')) {
        this.deps.callbacks.appendOutput('代码已交付，但缺少可启动的服务规格或受管服务能力；服务尚未就绪。');
        // A missing required service specification is an execution contract
        // failure, not a generic blocker: record it as a durable result.
        this.recordOperationResult({
          taskId,
          operationKey: 'service:start',
          operationKind: 'service',
          outcome: this.deps.managedLocalServices ? 'definite_failure' : 'unknown',
          reasonCode: this.deps.managedLocalServices
            ? 'service_start_failed'
            : 'external_outcome_unknown',
          message: this.deps.managedLocalServices
            ? PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION
            : '缺少受管服务能力，无法确认服务是否启动。',
          evidenceRefs: [`task:${taskId}`],
        });
        this.reconcileTaskState(taskId, {
          decisionId: `service_start:${taskId}`,
          operationKey: `service_start:${taskId}`,
          reason: 'required local service could not be started',
        });
      }
      return;
    }
    try {
      // The current specification owns this round. A historical record from an
      // earlier Task is diagnosis input, never a reason to observe instead of
      // start (2026-10-27 realignment §4.2).
      let verification = await this.verifyRequestedService(taskId, resourceTaskId);
      for (let round = 0; round < MAX_SERVICE_REPAIR_ROUNDS; round += 1) {
        const { view, spec, workspaceId } = verification;
        this.deps.callbacks.appendOutput(
          `服务 ${view.serviceId}：${view.state}；${view.message ?? ''}`
          + (view.url ? `；${view.url}` : ''),
        );
        if (isServiceReadyState(view.state)) {
          this.recordServiceStarted(taskId, spec, workspaceId);
          return;
        }
        // A service that did not reach health is feedback for the next
        // authorized continuation, not an immediate Task verdict.
        const dispatched = await this.requestServiceRepair({
          taskId,
          spec,
          workspaceId,
          view,
          workflow,
        });
        if (!dispatched) return;
        // The repair Attempt settled inside the supervisor drain. Re-verify the
        // same specification: the agent may have fixed the code, the command or
        // the health path.
        verification = await this.verifyRequestedService(taskId, resourceTaskId);
      }
      await this.handleServiceVerificationFailure({
        taskId,
        spec: verification.spec,
        workspaceId: verification.workspaceId,
        view: verification.view,
        budgetExhausted: true,
      });
    } catch (error) {
      this.reportServiceVerificationError(taskId, error);
    }
  }

  /**
   * Read the current specification and drive the authorized start/reconcile.
   *
   * A repair round may legitimately change the launch contract (port, command,
   * health path). The Kernel still owns that authorization: the new revision is
   * bound through the explicit `update` service operation before the launch.
   */
  private async verifyRequestedService(
    taskId: string,
    resourceTaskId: string,
  ): Promise<{
    view: LocalServiceView;
    spec: import('../task/local-service.js').LocalServiceSpecification;
    workspaceId: string;
  }> {
    const manager = this.deps.managedLocalServices!;
    let spec: import('../task/local-service.js').LocalServiceSpecification;
    let revisionDrifted = false;
    try {
      spec = (await manager.resolveServiceSpecification({ taskId: resourceTaskId })).specification;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('需要显式的服务更新授权')) throw error;
      spec = (await manager.resolveServiceSpecification({
        taskId: resourceTaskId,
        allowRevisionChange: true,
      })).specification;
      revisionDrifted = true;
    }
    const workspaceId = await manager.resolveServiceWorkspaceId(resourceTaskId);
    if (revisionDrifted) {
      // Preparation must finish while the old service is still available.
      // A repair Attempt receives this diagnostic and prepares the pinned root.
      if (await manager.prepareVersion(spec)) {
        return { view: {serviceId: spec.serviceId, taskId: resourceTaskId, state: 'failed', url: '', message: 'service_preparation_required：新版本准备完成后才能更新服务'}, spec, workspaceId };
      }
      if (await this.serviceProcessAlive(spec.serviceId, workspaceId)) {
        await this.manageLocalService(taskId, 'stop', spec.serviceId, undefined, false);
      }
      await this.manageLocalService(taskId, 'update', spec.serviceId, undefined, false);
    }
    const view = await this.manageLocalService(taskId, 'start', spec.serviceId, undefined, false);
    return { view, spec, workspaceId };
  }

  private recordServiceStarted(
    taskId: string,
    spec: import('../task/local-service.js').LocalServiceSpecification,
    workspaceId: string,
  ): void {
    const revision = localServiceSpecificationRevision(spec);
    const target = this.serviceRepairTarget(taskId);
    const ordinal = this.serviceRepairAttempts(taskId, target?.subtaskId ?? '');
    this.recordOperationResult({
      taskId,
      operationKey: this.serviceOperationKey(spec.serviceId, revision, target?.attemptId ?? null, ordinal),
      operationKind: 'service',
      outcome: 'success',
      reasonCode: null,
      message: spec.healthPath === null
        ? `服务 ${spec.serviceId} 已启动（该规格未声明健康检查）。`
        : `服务 ${spec.serviceId} 已通过健康检查。`,
      evidenceRefs: [`service:${spec.serviceId}`, `workspace:${workspaceId}`, `revision:${revision}`],
    });
    this.reconcileTaskState(taskId, {
      decisionId: `service_start:${taskId}:${spec.serviceId}:${revision}:${ordinal}:healthy`,
      operationKey: `service_start:${taskId}:${spec.serviceId}:${revision}:${ordinal}:healthy`,
      reason: `local service ${spec.serviceId} is healthy`,
    });
  }

  /**
   * Turn a failed service verification into one Kernel-authorized repair round.
   *
   * Returns `true` when a continuation Attempt was dispatched and settled, so the
   * caller can re-verify. Returns `false` when the failure is a conclusion: no
   * repair target, no budget left, or no driver to dispatch it.
   */
  private async requestServiceRepair(input: {
    taskId: string;
    spec: import('../task/local-service.js').LocalServiceSpecification;
    workspaceId: string;
    view: LocalServiceView;
    workflow?: KernelWorkflow;
  }): Promise<boolean> {
    const target = this.serviceRepairTarget(input.taskId);
    const ordinal = this.serviceRepairAttempts(input.taskId, target?.subtaskId ?? '');
    if (!target) {
      // Nothing to hand the feedback to: record the real diagnosis as the
      // conclusion instead of inventing an internal restart command.
      await this.handleServiceVerificationFailure({ ...input, budgetExhausted: false });
      return false;
    }
    if (ordinal >= MAX_SERVICE_REPAIR_ROUNDS) {
      await this.handleServiceVerificationFailure({
        ...input,
        target,
        budgetExhausted: true,
      });
      return false;
    }
    const failure = await this.handleServiceVerificationFailure({
      ...input,
      target,
      budgetExhausted: false,
      pendingRepair: true,
    });
    if (!input.workflow) {
      // No execution workflow is available in this drive. The durable
      // `repair_pending` fact keeps the Task running and the Subtask stays
      // `done`, so the next drive can still find the repair target and
      // authorize it (2026-10-27 review fix).
      return false;
    }
    const event = this.serviceRepairEvent({
      taskId: input.taskId,
      target,
      spec: input.spec,
      workspaceId: input.workspaceId,
      failure,
      ordinal,
    });
    let decisions;
    try {
      ({ decisions } = await input.workflow.submit(event));
    } catch (error) {
      await this.handleServiceVerificationFailure({
        ...input,
        target,
        budgetExhausted: true,
        refusal: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const decision = decisions.find(candidate => candidate.eventId === event.id);
    const authorized = decision?.action.type === 'dispatch_batch'
      && decision.action.items.some(item => item.subtaskId === target.subtaskId);
    if (!authorized) {
      // The Kernel refused the round (identity, budget or ordering). Report its
      // own reason instead of pretending a repair is running.
      await this.handleServiceVerificationFailure({
        ...input,
        target,
        budgetExhausted: true,
        refusal: decision?.reason ?? 'Kernel did not authorize a service repair continuation',
      });
      return false;
    }
    await this.attemptSupervisor.drain(input.taskId);
    return true;
  }

  private serviceOperationKey(
    serviceId: string,
    specificationRevision: string,
    sourceAttemptId: string | null,
    ordinal: number,
  ): string {
    // Idempotency is per source Attempt, per launch contract and per repair
    // round: two failures of different rounds must not overwrite each other.
    return `service:start:${serviceId}:${specificationRevision}:${sourceAttemptId ?? 'none'}:${ordinal}`;
  }

  /**
   * The Subtask whose work produced the requested service, plus the certified
   * Attempt to hand the feedback to.
   *
   * Feedback must never reach an unrelated Executor, so a candidate needs
   * positive evidence that it produced the service: it declared
   * `.metawork-service.json` as an output, or its observed Workspace delta
   * wrote that manifest. Only when the Generation has exactly one completed
   * Subtask is the single candidate accepted without that evidence.
   */
  private serviceRepairTarget(taskId: string): {
    subtaskId: string;
    attemptId: string;
    authorizedBinding: AuthorizedExecutorBinding;
    bindingFingerprint: string;
  } | null {
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const generationId = activeRevision?.generationId ?? `generation_${taskId}_1`;
    // `listByTask` is newest-first, so the first matching receipt is the Attempt
    // that produced the current code (or the latest repair round).
    const receipts = this.deps.attemptReceiptRepo.listByTask(taskId)
      .filter(receipt => receipt.generationId === generationId
        && receipt.terminalState !== 'contract_blocked');
    const candidates: Array<{
      subtaskId: string;
      attemptId: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
      producedService: boolean;
    }> = [];
    for (const receipt of receipts) {
      // A repair round hands feedback to the Executor that produced certified
      // work. An uncertified result has no agreed completion contract to repair.
      if (receipt.terminalState !== 'completed') continue;
      const subtask = this.deps.subtaskRepo.findById(receipt.subtaskId);
      if (!subtask || subtask.status !== 'done') continue;
      candidates.push({
        subtaskId: subtask.id,
        attemptId: receipt.attemptId,
        authorizedBinding: receipt.authorizedBinding,
        bindingFingerprint: receipt.bindingFingerprint,
        producedService: this.attemptProducedService(subtask.id, subtask.fileOutputs ?? [], receipt.attemptId),
      });
    }
    const evidence = candidates.find(candidate => candidate.producedService);
    if (evidence) {
      return {
        subtaskId: evidence.subtaskId,
        attemptId: evidence.attemptId,
        authorizedBinding: evidence.authorizedBinding,
        bindingFingerprint: evidence.bindingFingerprint,
      };
    }
    const distinctSubtasks = new Set(candidates.map(candidate => candidate.subtaskId));
    if (distinctSubtasks.size !== 1) {
      // Several completed Subtasks and no evidence which one owns the service:
      // refusing the feedback is safer than routing it to an unrelated Executor.
      return null;
    }
    const only = candidates[0]!;
    return {
      subtaskId: only.subtaskId,
      attemptId: only.attemptId,
      authorizedBinding: only.authorizedBinding,
      bindingFingerprint: only.bindingFingerprint,
    };
  }

  /** Whether this Attempt authored the service manifest Runtime launches. */
  private attemptProducedService(
    subtaskId: string,
    fileOutputs: readonly string[],
    attemptId: string,
  ): boolean {
    const manifest = LOCAL_SERVICE_SPECIFICATION_FILENAME;
    if (fileOutputs.some(output => output.replace(/^\.\//u, '') === manifest
      || output.endsWith(`/${manifest}`))) {
      return true;
    }
    const runtime = this.deps.attemptRuntimeRepo?.find(attemptId);
    const changed = runtime?.workspaceDelta && typeof runtime.workspaceDelta === 'object'
      ? (runtime.workspaceDelta as { changed?: unknown }).changed
      : null;
    if (!Array.isArray(changed)) return false;
    return changed.some(entry => {
      const path = entry && typeof entry === 'object'
        ? String((entry as { path?: unknown }).path ?? '')
        : '';
      return path === manifest || path.endsWith(`/${manifest}`);
    });
  }

  private latestServiceOutcome(
    taskId: string,
  ): 'success' | 'definite_failure' | 'unknown' | 'repair_pending' | null {
    const results = this.deps.taskOperationResults.listByTask?.(taskId) ?? [];
    return [...results].filter(result => result.operationKind === 'service').at(-1)?.outcome ?? null;
  }

  private serviceRepairAttempts(taskId: string, subtaskId: string): number {
    if (!subtaskId) return 0;
    // A cancelled dispatch never ran, so it must not consume the budget. This
    // is the same rule the Kernel applies through its snapshot fact.
    return serviceRepairRoundCounts(
      this.deps.dispatchItemRepo.listByTask(taskId)
        .filter(item => item.subtaskId === subtaskId),
    )[subtaskId] ?? 0;
  }

  private serviceRepairEvent(input: {
    taskId: string;
    target: {
      subtaskId: string;
      attemptId: string;
      authorizedBinding: AuthorizedExecutorBinding;
      bindingFingerprint: string;
    };
    spec: import('../task/local-service.js').LocalServiceSpecification;
    workspaceId: string;
    failure: { summary: string; reasonCode: import('../task/task-state.js').TaskReasonCode; logTail: string; exitObserved: boolean; healthStatus: number | null; specificationRevision: string };
    ordinal: number;
  }): KernelEvent {
    const configurationRevision = this.configurationRevisionForTask(input.taskId);
    const activeRevision = this.deps.workGraphRevisionRepo.findActive(input.taskId);
    const generationId = activeRevision?.generationId ?? `generation_${input.taskId}_1`;
    const serviceSource=this.deps.conversationWorktrees?.repo.sourceForTask(input.taskId);
    const serviceCheckout=serviceSource ? this.deps.conversationWorktrees!.repo.serviceWorktree(input.workspaceId,input.spec.serviceId,serviceSource.commit) : null;
    const nativeContinuation = !serviceCheckout && this.buildDispatchStableFacts(configurationRevision)
      .nativeContinuationAgentClasses
      .includes(input.target.authorizedBinding.agentClassRef);
    return {
      schemaVersion: 5,
      configurationRevision,
      type: 'dispatch_requested',
      // Deterministic per (Subtask, source Attempt, revision, round): a replay
      // can never authorize the same repair round twice.
      id: `service_repair_${input.taskId}_${input.target.subtaskId}_${input.target.attemptId}`
        + `_${input.failure.specificationRevision}_${input.ordinal}`,
      correlationId: input.taskId,
      causationId: input.target.attemptId,
      occurredAt: new Date().toISOString(),
      ...this.ownerEnvelopeForTask(input.taskId),
      taskId: input.taskId,
      subtaskId: input.target.subtaskId,
      reason: `service ${input.spec.serviceId} did not become healthy; repair round ${input.ordinal + 1}`,
      recovery: {
        authorizedBinding: input.target.authorizedBinding,
        bindingFingerprint: input.target.bindingFingerprint,
        attemptKind: 'continuation',
        sourceAttemptId: input.target.attemptId,
        recoveryMode: nativeContinuation ? 'native_session' : 'recovery_packet',
        defaultResourceGrant: defaultResourceGrant(
          input.taskId,
          generationId,
          input.target.subtaskId,
        ),
        attemptPayload: {
          protocol: 'metawork:service-repair:v1',
          ...(serviceCheckout ? {servicePreparation:{serviceWorktreeId:serviceCheckout.serviceWorktreeId,sourceCommit:serviceCheckout.sourceCommit,projectPath:serviceCheckout.projectPath}} : {}),
          serviceId: input.spec.serviceId,
          workspaceId: input.workspaceId || null,
          specificationRevision: input.failure.specificationRevision,
          repairOrdinal: input.ordinal,
          failure: {
            kind: 'service',
            code: input.failure.reasonCode,
            summary: input.failure.summary,
          },
          service: {
            command: input.spec.command,
            args: [...input.spec.args],
            healthUrl: input.spec.port === null
              ? ''
              : `http://${input.spec.host === '::1' ? '[::1]' : input.spec.host}:${input.spec.port}${input.spec.healthPath ?? ''}`,
            state: 'failed',
            exitObserved: input.failure.exitObserved,
            healthStatus: input.failure.healthStatus,
            logTail: input.failure.logTail.slice(-8_000),
          },
          knownProgress: [
            '代码已经写入授权 Workspace',
            '服务未通过健康检查',
          ],
          unknownItems: [
            '当前代码是否已修复服务未就绪的真实原因',
            '修复后的服务是否能在同一 Workspace 内通过健康检查',
          ],
        },
      },
    } as KernelEvent;
  }

  private reportServiceVerificationError(taskId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = normalizeExecutorFailure(message);
    const code = /EADDRINUSE|port_in_use/iu.test(message) ? 'port_in_use'
      : /ENOENT/iu.test(message) ? 'command_not_found'
      : /环境引用不可用|credential|authentication/iu.test(message) ? 'input_required'
      : normalized.code;
    if (message === PUBLISHED_CODE_MISSING_SERVICE_SPECIFICATION) {
      this.deps.callbacks.appendOutput(`${message}；服务尚未就绪。`);
    } else if (code === 'port_in_use') {
      // A real conflict names the port owner instead of asking the user to
      // discover it through an internal status command.
      this.deps.callbacks.appendOutput(
        `代码已交付，但服务端口被占用：${message}。停止占用该端口的进程或修改服务规格后重新运行。`,
      );
    } else if (message.includes('需要显式的服务更新授权') || message.includes('服务标识已绑定其他启动规格')) {
      this.deps.callbacks.appendOutput(
        `代码已交付，但服务规格与已授权规格不同：${message}。这需要一次显式的服务更新授权。`,
      );
    } else {
      this.deps.callbacks.appendOutput(`代码已交付，但服务启动失败：${message}`);
    }
    this.recordOperationResult({
      taskId,
      operationKey: `service:start:error:${code}`,
      operationKind: 'service',
      outcome: code === 'unknown' || code === 'input_required' ? 'unknown' : 'definite_failure',
      reasonCode: code === 'port_in_use' || code === 'command_not_found' || code === 'input_required'
        ? code : code === 'unknown' ? 'external_outcome_unknown' : 'service_start_failed',
      message,
      evidenceRefs: [`task:${taskId}`],
    });
    this.reconcileTaskState(taskId, {
      decisionId: `service_start_failed:${taskId}:${code}`,
      operationKey: `service_start:${taskId}:failed:${code}`,
      reason: `local service start failed: ${code}`,
    });
  }

  /**
   * Automatically re-do the remaining delivery/service work of a failed Task.
   *
   * `retry_remaining_work` is an internal recovery protocol: the user asked for a
   * running service or a delivered file, so the Runtime retries only that
   * remaining work instead of asking them to run a retry command
   * (2026-10-27 realignment §5.3). It is bounded to one round: a Task that is
   * itself a remaining-work retry never spawns another one, and an existing
   * successor is reused instead of duplicated.
   */
  private async attemptAutomaticRemainingWork(taskId: string): Promise<boolean> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task || task.status !== 'failed') return false;
    if (task.retryOfTaskId) return false;
    const successor = this.deps.taskRuntimeService.listTasks()
      .find(candidate => candidate.retryOfTaskId === taskId);
    if (successor) return false;
    try {
      const receipt = await this.retryRemainingWork(taskId);
      this.deps.callbacks.appendOutput(
        `已完成的工作保留；系统已自动创建续做任务 #${receipt.taskId}，只补做剩余的交付或服务启动。`,
      );
      this.reconcileTaskState(taskId, {
        decisionId: `remaining_work_auto:${taskId}:${task.stateVersion}`,
        operationKey: `remaining_work_auto:${taskId}:${task.stateVersion}`,
        reason: 'remaining delivery or service work is retried automatically',
      });
      return true;
    } catch {
      // The Kernel refused (unsafe reuse, unknown external effect or an expired
      // version). Recording the real failure stays the conclusion.
      return false;
    }
  }

  /** Whether the current specification already owns a live process. */
  private async serviceProcessAlive(serviceId: string, workspaceId: string): Promise<boolean> {
    const manager = this.deps.managedLocalServices;
    if (!manager) return false;
    const observation = await manager.observe?.(serviceId, workspaceId).catch(() => null) ?? null;
    return observation !== null
      && ['starting', 'running', 'healthy', 'unhealthy'].includes(observation.view.state);
  }

  /**
   * Single收口 for a service that did not reach health.
   *
   * The 2026-10-27 realignment (§4.3/§4.4) makes this failure a bounded fact:
   * the current Attempt already ended, so the Runtime records the real diagnosis
   * (exit fact, health status, redacted log tail, revision) and only then decides
   * whether an authorized repair round follows. Nothing here rewrites the
   * Harness context, calls a model or replays a process start.
   */
  private async handleServiceVerificationFailure(input: {
    taskId: string;
    spec: import('../task/local-service.js').LocalServiceSpecification;
    workspaceId: string;
    view: LocalServiceView;
    target?: {
      subtaskId: string;
      attemptId: string;
    };
    budgetExhausted: boolean;
    pendingRepair?: boolean;
    /** The Kernel's own reason when it refused the authorized repair round. */
    refusal?: string;
  }): Promise<{
    summary: string;
    reasonCode: import('../task/task-state.js').TaskReasonCode;
    logTail: string;
    exitObserved: boolean;
    healthStatus: number | null;
    specificationRevision: string;
  }> {
    const serviceId = input.view.serviceId;
    const manager = this.deps.managedLocalServices;
    const observation = manager
      ? await manager.observe?.(serviceId, input.workspaceId).catch(() => null) ?? null
      : null;
    const healthTimeout = /health|unhealthy/iu.test(input.view.message ?? '');
    const reasonCode: import('../task/task-state.js').TaskReasonCode = healthTimeout
      ? 'service_health_timeout'
      : 'service_start_failed';
    const logTail = observation?.diagnostics.logTail?.trim() ?? '';
    const summary = [
      input.view.message ?? input.view.state,
      `serviceId=${serviceId}`,
      `state=${input.view.state}`,
      observation?.diagnostics.exitObserved ? '进程已退出' : null,
      observation?.diagnostics.healthStatus !== null && observation?.diagnostics.healthStatus !== undefined
        ? `健康检查=${observation.diagnostics.healthStatus}`
        : null,
    ].filter(Boolean).join('，');
    const specificationRevision = observation?.diagnostics.specificationRevision
      ?? localServiceSpecificationRevision(input.spec);
    const refusal = input.refusal?.trim() ? boundRefusal(input.refusal) : null;
    const target = input.target ?? this.serviceRepairTarget(input.taskId) ?? null;
    const ordinal = this.serviceRepairAttempts(input.taskId, target?.subtaskId ?? '');
    this.deps.callbacks.appendOutput(
      refusal
        ? `服务 ${serviceId} 未能就绪：${summary}。Kernel 未授权自动修复：${refusal}`
        : input.budgetExhausted
          ? `服务 ${serviceId} 未能就绪：${summary}。已尝试 ${ordinal} 轮自动修复仍未通过，代码保留在 Workspace 中。`
          : `服务 ${serviceId} 未能就绪：${summary}。`,
      '',
      logTail ? `服务日志尾部：\n${logTail}` : '服务没有可用的日志输出。',
    );
    this.appendExecutionTrace({
      phase: 'verification',
      actor: 'kernel',
      kind: 'service_verification_failed',
      status: input.budgetExhausted ? 'failed' : 'blocked',
      title: 'Local service did not become healthy',
      summary,
      details: {
        // Bounded, secret-free repair input for the authorized Attempt.
        service: {
          serviceId,
          workspaceId: input.workspaceId,
          specificationRevision,
          command: input.spec.command,
          args: [...input.spec.args],
          healthUrl: `${input.view.url}${input.spec.healthPath}`,
          state: input.view.state,
          exitObserved: observation?.diagnostics.exitObserved ?? false,
          healthStatus: observation?.diagnostics.healthStatus ?? null,
          retryable: observation?.diagnostics.retryable ?? healthTimeout,
          logTail: logTail.slice(-8_000),
          repairOrdinal: ordinal,
          budgetExhausted: input.budgetExhausted,
          ...(refusal ? { refusal } : {}),
        },
        ...(target ? { sourceAttemptId: target.attemptId, subtaskId: target.subtaskId } : {}),
      },
      eventKey: `service_verification_failed:${input.taskId}:${serviceId}:${specificationRevision}:${target?.attemptId ?? 'none'}:${ordinal}`,
      taskId: input.taskId,
      traceStatus: input.budgetExhausted ? 'failed' : 'blocked',
    });
    this.recordOperationResult({
      taskId: input.taskId,
      operationKey: this.serviceOperationKey(
        serviceId,
        specificationRevision,
        target?.attemptId ?? null,
        ordinal,
      ),
      operationKind: 'service',
      outcome: input.pendingRepair ? 'repair_pending' : 'definite_failure',
      reasonCode,
      // A refusal is part of the diagnosis: the TaskView reason must name both
      // the real service failure and why no repair round ran.
      message: refusal ? `${summary}（Kernel 未授权自动修复：${refusal}）` : summary,
      evidenceRefs: [
        `service:${serviceId}`,
        `revision:${specificationRevision}`,
        ...(target ? [`attempt:${target.attemptId}`, `subtask:${target.subtaskId}`] : []),
      ],
    });
    this.reconcileTaskState(input.taskId, {
      decisionId: `service_start:${input.taskId}:${serviceId}:${specificationRevision}:${ordinal}:${input.view.state}`,
      operationKey: `service_start:${input.taskId}:${serviceId}:${specificationRevision}:${ordinal}:${input.view.state}`,
      reason: input.pendingRepair
        ? `local service ${serviceId} failed; repair round ${ordinal + 1} queued`
        : `local service ${serviceId} is ${input.view.state}${refusal ? `; repair refused: ${refusal}` : ''}`,
    });
    if (!input.pendingRepair) {
      // The repair budget (or the Kernel) ended this line of work. If the code
      // is already delivered, retry the remaining work instead of making the
      // user run a retry command.
      await this.attemptAutomaticRemainingWork(input.taskId);
    }
    return {
      summary,
      reasonCode,
      logTail,
      exitObserved: observation?.diagnostics.exitObserved ?? false,
      healthStatus: observation?.diagnostics.healthStatus ?? null,
      specificationRevision,
    };
  }

  private recordOperationResult(input: {
    taskId: string;
    operationKey: string;
    operationKind: 'execution' | 'integration' | 'delivery' | 'safety_report' | 'service';
    outcome: 'success' | 'definite_failure' | 'unknown' | 'repair_pending';
    reasonCode: import('../task/task-state.js').TaskReasonCode | null;
    message: string;
    evidenceRefs: readonly string[];
  }): void {
    this.deps.taskOperationResults.record({ ...input, updatedAt: new Date().toISOString() });
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

  /**
   * Bounded residual facts the Executor adapter recorded when it reaped the
   * Attempt's process group. Pid plus executable basename only.
   */
  private residualProcessFacts(attemptId: string): {
    members: Array<{ pid: number; command: string }>;
    signalled: string;
  } | null {
    const progress = this.deps.attemptRuntimeRepo?.find(attemptId)?.progress as
      Record<string, unknown> | undefined;
    const diagnostics = progress?.diagnostics as Record<string, unknown> | undefined;
    const process = diagnostics?.process as Record<string, unknown> | undefined;
    const group = process?.residualGroup as Record<string, unknown> | undefined;
    if (!group || !Array.isArray(group.members)) return null;
    const members = group.members
      .filter((member): member is { pid: number; command: string } => Boolean(member)
        && typeof (member as { pid?: unknown }).pid === 'number'
        && typeof (member as { command?: unknown }).command === 'string')
      .slice(0, 20)
      .map(member => ({ pid: member.pid, command: member.command.slice(0, 64) }));
    if (members.length === 0) return null;
    return { members, signalled: String(group.signalled ?? 'unknown') };
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
    // A settled Attempt must not leave unowned processes behind. When the
    // Runtime had to stop leftovers in the Attempt's process group, say so: the
    // fact belongs to this Attempt's record, not to a silent success
    // (2026-10-28 transparent execution §execution-fact contract).
    const residual = this.residualProcessFacts(item.attemptId);
    this.appendExecutionTrace({
      phase: 'verification',
      actor: 'executor',
      kind: 'executor_result_observed',
      status,
      title: isCompleted ? 'Executor result observed' : 'Executor attempt settled',
      summary: isCompleted
        ? residual
          ? `Executor completed the authorized attempt; Runtime stopped ${residual.members.length} process(es) it left running, then verified the result.`
          : 'Executor completed the authorized attempt; Runtime is verifying the result.'
        : isContractResult
          ? 'Executor returned a result that Runtime is certifying for delivery.'
          : outcome.outcome === 'executor_unavailable'
            ? outcome.failure.summary
          : outcome.outcome === 'executor_failed'
            ? 'Executor failed; Kernel will decide recovery or retry.'
            : 'Executor attempt became stale or was cancelled.',
      details: {
        taskId: item.taskId,
        attemptId: item.attemptId,
        executorName: item.authorizedBinding.agentClassRef,
        outcome: outcome.outcome,
        ...(residual ? { residualProcesses: residual.members, residualSignal: residual.signalled } : {}),
        ...(isContractResult ? {
          deliverability: outcome.deliverability,
          certification: outcome.certification,
          safety: outcome.safety,
          resultId: outcome.resultId ?? null,
        } : {}),
        ...(outcome.outcome === 'executor_failed' ? {
          failureCode: outcome.failure.code,
          // Passthrough: the Client sees what actually failed, not a category.
          failureSummary: outcome.failure.summary,
          ...(outcome.failure.label ? { failureLabel: outcome.failure.label } : {}),
          ...(outcome.failure.step ? { failureStep: outcome.failure.step } : {}),
          ...(outcome.failure.provider ? { failureProvider: outcome.failure.provider } : {}),
          ...(outcome.failure.detail ? { failureDetail: outcome.failure.detail } : {}),
          ...(outcome.failure.stage ? { failureStage: outcome.failure.stage } : {}),
          ...(outcome.failure.retryable !== undefined ? { failureRetryable: outcome.failure.retryable } : {}),
          ...(outcome.failure.attemptStarted !== undefined ? { attemptStarted: outcome.failure.attemptStarted } : {}),
          ...(outcome.failure.externalSideEffect !== undefined ? { externalSideEffect: outcome.failure.externalSideEffect } : {}),
          ...(outcome.failure.userAction ? { userAction: outcome.failure.userAction } : {}),
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

  /**
   * Recovery re-evaluates only a block that durable facts may already resolve:
   * a system-caused block, or the official-authorization gate. A block that
   * asks the user for material, acceptance or a decision is left untouched (its
   * reason is the current, correct one).
   */
  private shouldReconcileBlockedTask(task: import('../core/types.js').Task): boolean {
    const reason = task.stateDetail?.reason;
    if (!reason) return false;
    if (reason.code === 'no_authorized_driver' || reason.code === 'system_anomaly') return true;
    return /official authorization state:|official_authorization_required/u.test(reason.message ?? '');
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
    if (!task || !['running', 'blocked'].includes(task.status) || !subtask || subtask.status !== 'ready') return false;

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
      productionAuthorization: this.deps.productionAuthorization,
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
            task: { id: task.id, status: this.deps.taskRuntimeService.findTask(task.id)?.status ?? task.status },
            wakeAuthorized: this.isKernelWakeAuthorized(this.deps.taskRuntimeService.findTask(task.id) ?? task, event.wakeKind),
            capacityBlockedAt: input.blockedAt,
            recheckAfterMs: input.recheckAfterMs,
            capacityBindings: subtask.executorBindings,
            nativeContinuationAgentClasses: stableFacts.nativeContinuationAgentClasses,
            executorStatuses: stableFacts.executorStatuses,
            defaultResourceGrant: defaultResourceGrant(task.id, subtask.generationId, subtask.id),
            retryWake: this.retryWakeFact(event.retry?.wakeId),
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
        'recovery_required_observed',
      ],
      acceptedActions: [
        'dispatch_batch', 'probe_capacity', 'wait_for_capacity', 'wait_for_retry',
        'supersede_retry_wake', 'recover_retry_wake',
        'block_work', 'await_user_decision', 'park_for_replan', 'complete_task', 'request_replan', 'schedule_replan',
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

  private deliverSafeResultOnBlock(taskId: string, reason: string): void {
    try {
      const pending = this.deps.cancellationCoordinator.buildSnapshot(taskId).uncertifiedResult;
      if (!pending) return;
      const safe = pending.resultId;
      const object = this.deps.resultObjectRepo?.findObject(safe);
      if (!object) return;
      const content = this.deps.resultObjectRepo?.readRange(safe, 0, object.byteLength)?.content ?? '';
      if (!content.trim()) return;
      this.deps.callbacks.recordResultDelivery({
        resultId: safe,
        content,
        completeness: 'partial',
        certification: 'uncertified',
      });
      this.deps.callbacks.appendOutput(
        content,
        '',
        `未认证部分输出（${reason}），仅供人工参考，不代表任务完成；结果需要处理。`,
      );
    } catch {
      // Delivery-on-block is best-effort and must never mask the block itself.
    }
  }

  private async blockTaskInternal(
    taskId: string,
    reason: string,
    finishExecution: (lines: string[], scheduleNext?: boolean) => Promise<void> = async () => undefined,
    dependencyType: import('../core/types.js').Dependency['type'] = 'manual',
  ): Promise<void> {
    const localBlockers = this.deps.subtaskRepo.listByTask?.(taskId)
      // An uncertified result is deliberately kept in `awaiting_decision` so
      // the Kernel can offer an exact recovery path. Preserve its error when
      // the follow-up dispatch has no runnable frontier; otherwise the Task
      // would be rewritten with only the generic frontier message.
      .filter(subtask => (
        subtask.status === 'blocked' || subtask.status === 'awaiting_decision'
      ) && subtask.error)
      .map(subtask => `${subtask.title}: ${subtask.error}`).slice(0, 4) ?? [];
    const blockedReason = this.blockReasonWithCause(taskId, [reason, ...localBlockers].join('; '));
    const current = this.deps.taskRuntimeService.findTask(taskId);
    if (current && current.status !== 'succeeded' && current.status !== 'failed'
      && current.status !== 'cancelled') {
      // The blocker is a durable Task fact; the authority turns it into the one
      // conclusion (needs_action, queued for capacity, or failed).
      const operationId = `block:${taskId}:${dependencyType}:${current.stateVersion}`;
      this.reconcileTaskState(taskId, {
        decisionId: operationId,
        operationKey: operationId,
        reason: blockedReason,
        facts: () => {
          this.deps.taskRuntimeService.updateTask(taskId, {
            dependencies: [
              ...current.dependencies.filter(dependency => !(dependency.status === 'waiting'
                && dependency.type === dependencyType && dependency.description === blockedReason)),
              { taskId, type: dependencyType, description: blockedReason,
                status: 'waiting', createdAt: new Date().toISOString() },
            ],
          });
          return [];
        },
      });
    }
    this.recordTaskEvent(taskId, null, 'phase2_execution_blocked', blockedReason, {});
    await finishExecution([`Execution needs attention: ${blockedReason}`]);
  }

  /**
   * Names the Executor failure that caused a block next to the Kernel policy
   * reason, so a blocked Task explains itself instead of only saying that some
   * unnamed state needs manual recovery.
   */
  private blockReasonWithCause(taskId: string, reason: string): string {
    const failure = (this.deps.attemptReceiptRepo?.listByTask(taskId) ?? [])
      .map(receipt => receipt.failure)
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
      .at(0);
    if (!failure) return reason;
    const interruptedStream = /(?:upstream\s+)?response\s+stream\s+(?:was\s+)?interrupted/i.test(failure.summary);
    const cause = [
      interruptedStream ? '上游模型响应流中断，未收到可用结果' : (failure.label ?? failure.code),
      failure.summary,
      failure.stage ? `阶段：${failure.stage}` : null,
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(': ');
    if (!cause || reason.includes(failure.summary)) return reason;
    return `${reason}（${cause}）`;
  }

  private async waitForRetry(
    taskId: string,
    subtaskId: string,
    resumeAt: string,
    decision: KernelDecision,
    action: Extract<KernelDecision['action'], { type: 'wait_for_retry' }>,
    finishExecution: (lines: string[], scheduleNext?: boolean) => Promise<void>,
  ): Promise<void> {
    const reason = `retry scheduled for ${resumeAt}`;
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const subtask = this.deps.subtaskRepo.findById(subtaskId);
    if (!task || !subtask || subtask.taskId !== taskId) {
      throw new Error(`Retry Wake target no longer exists: ${taskId}/${subtaskId}`);
    }
    if (['done', 'cancelled'].includes(subtask.status)) {
      throw new Error(`Retry Wake target Subtask is terminal: ${taskId}/${subtaskId}`);
    }
    if (task.status !== 'running' && task.status !== 'needs_action' && task.status !== 'queued') {
      throw new Error(`Retry Wake target Task is not recoverable: ${taskId}/${task.status}`);
    }
    const revision = this.deps.workGraphRevisionRepo.findActive(taskId);
    const generationId = revision?.generationId ?? subtask.generationId;
    const wakeId = `retry_wake_${decision.id}`;
    const createdAt = new Date().toISOString();
    const persistRetry = () => {
      this.deps.retryWakeRepo.arm({
        wakeId,
        taskId,
        subtaskId,
        generationId,
        sourceDecisionId: decision.id,
        sourceAttemptId: action.sourceAttemptId,
        configurationRevision: decision.configurationRevision,
        bindingFingerprint: action.bindingFingerprint,
        authorizedBindingJson: JSON.stringify(action.authorizedBinding),
        resumeAt,
        wakeKind: 'retry',
        status: 'armed',
        timerEventId: null,
        consumedDecisionId: null,
        createdAt,
        updatedAt: createdAt,
      });
      const findWake = (this.deps.retryWakeRepo as Partial<RetryWakeRepo>).findById;
      if (findWake) {
        const wake = findWake.call(this.deps.retryWakeRepo, wakeId);
        if (
          !wake
          || wake.taskId !== taskId
          || wake.subtaskId !== subtaskId
          || wake.sourceDecisionId !== decision.id
          || wake.status !== 'armed'
        ) {
          throw new Error(`Retry Wake ${wakeId} did not reach the armed postcondition`);
        }
      }
    };
    if (this.deps.runInTransaction) this.deps.runInTransaction(persistRetry);
    else persistRetry();
    this.recordTaskEvent(taskId, null, 'phase2_execution_waiting_retry', reason, {});
    this.appendExecutionTrace({
      phase: 'verification',
      actor: 'kernel',
      kind: 'execution_waiting_retry',
      status: 'blocked',
      title: '等待自动重试',
      summary: `上游执行暂时不可用，系统将在 ${resumeAt} 自动重试。`,
      details: {
        taskId,
        subtaskId,
        attemptId: action.sourceAttemptId,
        resumeAt,
        retryable: true,
      },
      eventKey: `${decision.id}:waiting_retry`,
      taskId,
      traceStatus: 'blocked',
    });
    await finishExecution([`Execution will retry automatically at ${resumeAt}`]);
  }

  private isKernelWakeAuthorized(task: import('../core/types.js').Task, wakeKind: Extract<KernelEvent, { type: 'timer_tick' }>['wakeKind']): boolean {
    if (wakeKind === 'retry') return ['running', 'blocked'].includes(task.status);
    const expectedType = wakeKind === 'capacity'
        ? 'kernel_capacity'
        : 'kernel_availability';
    return ['running', 'blocked'].includes(task.status)
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

    const graph=this.deps.workGraphRevisionRepo.findActive(input.taskId)??this.deps.workGraphRevisionRepo.findLatest(input.taskId);
    const conversationBinding=graph&&this.deps.conversationWorktrees?.repo.binding(input.taskId,graph.generationId);
    const effectId = conversationBinding ? `workspace_completion:${input.taskId}:${graph!.generationId}` : `effect_${input.decisionId}_task_completion`;
    if (this.deps.effectOutboxRepo.find(effectId)) {
      // The notification may have committed before the caller observed graph
      // closure. Repair graph state without emitting a second interaction.
      if (input.revisionCompletion && task.status === 'succeeded') {
        this.deps.workGraphRevisionRepo.complete(input.taskId, input.revisionCompletion.revision,
          new Date().toISOString(), input.revisionCompletion.completionKind);
      }
      return;
    }
    const effectPayload = {
      taskId: input.taskId,
      title: task.title,
      summary: cleanAggregate,
      output: cleanAggregate,
      artifactPaths: artifacts,
      durationMs: (() => {
        const attempts=this.deps.dispatchItemRepo.listByTask(input.taskId).filter(item=>item.generationId===graph?.generationId);
        const durations=attempts.flatMap(item=>{
          const runtime=this.deps.attemptRuntimeRepo?.find(item.attemptId);
          const start=runtime?.writeStartedAt??item.launchStartedAt;
          const end=runtime?.writeFinishedAt??item.terminalAt;
          if(!start||!end)return [];
          const ms=Date.parse(end)-Date.parse(start);
          return Number.isFinite(ms)&&ms>=0?[ms]:[];
        });
        return durations.length?durations.reduce((a,b)=>a+b,0):null;
      })(),
      executionMode: input.request.executionMode,
      origin: input.request.origin ?? 'user',
      recoveryTrigger: input.request.recoveryTrigger,
      completionKind,
      cancelledSubtaskIds: cancelledSubtasks.map(subtask => subtask.id),
    };
    let completed = false;
    this.deps.effectOutboxRepo.transaction(() => {
      this.deps.taskRuntimeService.updateTask(input.taskId, { summary: cleanAggregate, artifacts });
      // Completion gate (design §3.4): closing the authorized graph and telling
      // the user the Task finished is only allowed when the required work — code,
      // file delivery, safety report and a required service — is proven complete.
      // Otherwise the Task keeps its derived conclusion (e.g. `needs_action` with
      // a delivery recovery action) and the graph stays active for the retry.
      this.reconcileTaskState(input.taskId, {
        decisionId: input.decisionId,
        operationKey: `complete:${input.decisionId}`,
        reason: `Kernel decision ${input.decisionId} completed the Task`,
      });
      if (this.deps.taskRuntimeService.findTask(input.taskId)?.status !== 'succeeded') return;
      completed = true;
      if (input.revisionCompletion) {
        this.deps.workGraphRevisionRepo.complete(
          input.taskId,
          input.revisionCompletion.revision,
          new Date().toISOString(),
          input.revisionCompletion.completionKind,
        );
      }
      this.deps.persistenceService.recordInteraction({
        taskId: input.taskId,
        sessionId: this.sessionId,
        userInput: input.request.userPrompt,
        systemOutput: cleanAggregate,
        executorUsed: input.subtasks.length === 1
          ? input.subtasks[0]!.executorBindings[0]?.agentClassRef ?? 'executor'
          : 'work-graph',
      });
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
    if (!completed) {
      const pending = this.deps.taskRuntimeService.findTask(input.taskId);
      await input.finishExecution([
        `Task #${input.taskId} 尚未完成：${pending?.stateDetail.reason.message || '必需工作尚未全部完成'}。`,
      ]);
      this.deps.callbacks.refreshRuntimeState();
      return;
    }
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

    // A completion decision can be applied while the last dispatch fact is
    // still settling; one post-commit reconciliation converges the conclusion
    // from the now-final facts (a no-op when it already reached `succeeded`).
    this.reconcileTaskState(input.taskId, {
      decisionId: input.decisionId,
      operationKey: `complete_settle:${input.decisionId}`,
      reason: `post-commit convergence for ${input.decisionId}`,
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
