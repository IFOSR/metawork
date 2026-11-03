import { supportsSharedWorkspaceRead } from '../work-graph/workspace-effect.js';
import { resolveSafeResult, type PendingResultIdentity } from '../task/safe-result-identity.js';
import { readPendingTaskResult } from '../storage/pending-task-result.js';
import { ExecutorProbeError } from './work-unit-claim-service.js';
import { partitionCovers } from '../resource/partition.js';
import { workspaceRootClaim } from '../resource/workspace-claim.js';
import { createHash } from 'node:crypto';
import { isWithin, isWorkspaceRelativePath } from '../workspace/workspace-path.js';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { InteractionReferenceError } from '../work-graph/context-ref-eligibility.js';
import { ExecutionEvidenceIdentityError } from './execution-evidence-port.js';
import { describeAttemptFailure } from './failure-reasons.js';
import type { ExecutorProgressEvent } from '../executor/adapter.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
import type { HarnessUsageEvent } from '../executor/harness-driver.js';
import type { Payer } from '../billing/cost-policy.js';
import type { MeteringSpanRecord } from '../metering/ports.js';
import type { RawUsageEvent } from '../metering/usage-normalizer.js';
import type { AgentClassService } from '../executor/agent-class-service.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import {
  ExecutorAttemptReceiptRepo,
  type ExecutorAttemptReceipt,
  type ExecutorAttemptReceiptInsert,
} from '../storage/executor-attempt-receipt-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { PersistedSubtaskHandoffItem } from '../storage/subtask-handoff-repo.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { ExecutionMode } from './types.js';
import type { WorkspaceExecutionBindingRepo } from '../storage/workspace-execution-binding-repo.js';
import {
  executionContextFromConversation,
} from './execution-context.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import {
  COMPLETION_MARKER_V4,
  validateCompletionProtocol,
  type CompletionAssessment,
  type CompletionContractViolation,
  type CompletionHandoffV3,
} from './completion-protocol.js';
import { SubtaskExecutionContextBuilder } from './subtask-execution-context.js';
import type { GatewayAttachmentStore } from '../gateway/attachment-store-port.js';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';
import { generateInteractionId } from '../utils/id.js';
import { ExecutionEvidenceToolServer } from './execution-evidence-tool-server.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import type { Subtask, Task } from '../core/types.js';
import { ExecutorAttemptRuntimeRepo, type ExecutorAttemptRuntimeRecord } from '../storage/executor-attempt-runtime-repo.js';
import { deriveRecoverySafety } from '../routing/types.js';
import {
  createSubtaskLifecyclePort,
  type SubtaskLifecyclePort,
} from '../task/task-lifecycle-transition-port.js';
import type {
  KernelAttemptKind,
  KernelAttemptPayload,
  KernelRecoveryMode,
} from '../kernel/control-kernel.js';
import {
  captureWorkspaceState,
  captureWorkspaceStateAtPaths,
  deriveWorkspaceDelta,
  parseWorkspaceDelta,
  parseWorkspaceState,
  classifyWorkspaceCaptureFailure,
  type WorkspaceDelta,
  type WorkspaceCaptureFailure,
  type WorkspaceState,
} from './workspace-change-tracker.js';
import type { WorkspaceStore, WorkspaceHandle } from './workspace-store.js';
import type { AttemptExecutionBackend } from './attempt-execution-backend.js';
import {
  buildPermissionRules,
  type PermissionRepositoryPort,
  type ResourceClaim,
} from '../resource/index.js';
import type { ResourceLeaseService } from './resource-lease-service.js';
import { RegisteredCapabilityResourceResolver } from './capability-resource-resolver.js';
import { PermissionWorkflowService } from './permission-workflow-service.js';
import { CapabilityRequestToolServer } from './capability-request-tool-server.js';
import type { KernelWorkflowStore } from '../kernel/kernel-workflow.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import { ManagedGitWorkspaceService, type ManagedGitWorkspace } from './managed-git-workspace.js';
import {
  KernelDispatchItemRepo,
  type KernelDispatchItemRecord,
} from '../storage/kernel-dispatch-item-repo.js';
import {
  WorkspacePublicationRepo,
} from '../storage/workspace-publication-repo.js';
import { AttemptTerminalService } from './attempt-terminal-service.js';
import { authorizedExecutorBindingFingerprint, type AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import { MemoryEvidenceMaterializationError, MemoryEvidenceService } from '../memory/memory-evidence-service.js';
import {
  formatExecutorProgress,
  normalizeDependencyMaterializationFailure,
} from '../executor/error-utils.js';
import { kernelFailure } from '../core/kernel-failure.js';
import {
  EdgeHandoffMaterializationError,
  assertEdgeHandoffsMaterializable,
  materializeOutgoingHandoffs,
} from './subtask-handoff-materializer.js';
import { publicText } from '../utils/public-text.js';
import {
  ResultObjectRepo,
  type ResultObjectWriter,
} from '../storage/result-object-repo.js';
import type { ScopedExecutionResultReferencePort } from './execution-result-reference-port.js';
import {
  MERGE_REPAIR_MARKER,
  MERGE_REPAIR_PROTOCOL,
  parseMergeRepairReport,
} from './merge-repair-protocol.js';

export type ProgressCallback = (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;

export interface AuthorizedAttemptIdentity {
  authorizedBinding: AuthorizedExecutorBinding;
  bindingFingerprint: string;
}

export type SubtaskAttemptOutcome =
  | {
      outcome: 'completed';
      attemptId: string;
      output: string;
      artifacts: string[];
      warnings: string[];
      executorName: string;
      durationMs: number;
      resultId?: string;
    }
  | { outcome: 'executor_unavailable'; attemptId: string; failure: KernelFailure }
  | { outcome: 'capacity_unavailable'; attemptId: string; agentClassName: string }
  | {
      outcome: 'contract_failed';
      attemptId: string;
      workUnitId: string;
      agentClassName: string;
      responseBytes: number;
      receiptCount: number;
      completionContract: unknown;
      violations: CompletionContractViolation[];
      output?: string;
      resultId?: string;
      deliverability: CompletionAssessment['deliverability']['status'];
      certification: CompletionAssessment['certification']['status'];
      safety: CompletionAssessment['safety']['status'];
    }
  | { outcome: 'executor_failed'; attemptId: string; error: string; failure: KernelFailure }
  | { outcome: 'partition_conflict'; attemptId: string; claims: ResourceClaim[]; conflictingLeaseIds: string[] }
  | { outcome: 'cancelled_or_stale'; attemptId: string; reason: string };

export interface SubtaskAttemptRunnerDeps {
  db: Database.Database;
  sessionId: string;
  getSessionId?(): string;
  taskRuntimeService: TaskRuntimeService;
  subtaskRepo: SubtaskRepo;
  workUnitClaimService: Pick<WorkUnitClaimService, 'claim' | 'isClaimCurrent'>;
  executionRuntime: ExecutionRuntime;
  agentClassService: AgentClassService;
  workspaceStore: WorkspaceStore;
  attemptExecutionBackend: AttemptExecutionBackend;
  resourceLeaseService: ResourceLeaseService;
  /** Immutable per-generation Workspace facts; absent only in focused tests. */
  conversationWorktrees?: import('./conversation-worktree-service.js').ConversationWorktreeService;
  serviceWorktrees?: import('./service-worktree-service.js').ServiceWorktreeService;
  workspaceExecutionBindingRepo?: WorkspaceExecutionBindingRepo;
  /** `<objectsPath>/artifacts`: content-addressed store for fixed ArtifactVersions. */
  artifactObjectRoot?: string;
  permissionRepository: PermissionRepositoryPort;
  kernelWorkflowStore: KernelWorkflowStore;
  workspaceRepository: WorkspaceRepositoryPort;
  sourceRoot: string;
  controlNetwork: string;
  accountId?: string;
  resultRoot: string;
  attachmentStore?: GatewayAttachmentStore;
  /**
   * When present, attempt-output files are registered as user-visible
   * artifacts at landing — independent of the git publication ceremony, so
   * correction-path completions register too. Dedupe is content-hash based
   * inside the service, making the publication worker's later registration
   * a no-op for identical content.
   */
  userArtifactPublication?: import('../delivery/user-artifact-publication-service.js').UserArtifactPublicationService | null;
  usageObserver?: (event: RawUsageEvent) => void;
  usageSpanOpener?: (span: MeteringSpanRecord) => void;
  usageSpanCloser?: (spanId: string, state: 'closed' | 'uncertain', closedAt: string) => void;
  usagePayer?: Payer;
  /**
   * Long-term memory delivery. The memory references of the Subtask are
   * materialized into execution evidence before the context is built
   * (design §10).
   */
  memoryEvidence?: import('../memory/memory-evidence-service.js').MemoryEvidencePort;
}

/** Owns one Subtask attempt from claim through immutable terminal persistence. */
export class SubtaskAttemptRunner {
  /**
   * The account-wide `sourceRoot` is a legacy default, not the Workspace of a
   * specific Task. If it points at the internal workspace store, importing it
   * would copy the store into one of its own repositories, so refuse with the
   * real reason instead of surfacing a self-import error.
   */
  private requireSourceRoot(purpose: string): string {
    const configured = resolve(this.deps.sourceRoot);
    const storeRoot = resolve(this.deps.workspaceStore.rootPath);
    if (configured === storeRoot || configured.startsWith(`${storeRoot}${sep}`)) {
      throw new Error(
        `${purpose} has no authorized Workspace source: the configured source root is the internal `
        + `workspace store (${storeRoot})`,
      );
    }
    return this.deps.sourceRoot;
  }

  private readonly contextBuilder: SubtaskExecutionContextBuilder;
  private readonly receiptRepo: ExecutorAttemptReceiptRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;
  private readonly attemptRuntimeRepo: ExecutorAttemptRuntimeRepo;
  private readonly managedGitWorkspace: ManagedGitWorkspaceService;
  private readonly dispatchItemRepo: KernelDispatchItemRepo;
  private readonly publicationRepo: WorkspacePublicationRepo;
  private readonly terminalService: AttemptTerminalService;
  private readonly resultObjectRepo: ResultObjectRepo;
  private readonly lifecycle: SubtaskLifecyclePort;

  constructor(private readonly deps: SubtaskAttemptRunnerDeps) {
    this.lifecycle = createSubtaskLifecyclePort({ subtaskRepo: deps.subtaskRepo });
    this.contextBuilder = new SubtaskExecutionContextBuilder(deps.db, {
      accountId: deps.accountId,
      resultRoot: deps.resultRoot,
      attachmentStore: deps.attachmentStore,
      ...(deps.artifactObjectRoot ? { artifactObjectRoot: deps.artifactObjectRoot } : {}),
    });
    this.receiptRepo = new ExecutorAttemptReceiptRepo(deps.db);
    this.handoffRepo = new SubtaskHandoffRepo(deps.db);
    this.attemptRuntimeRepo = new ExecutorAttemptRuntimeRepo(deps.db);
    this.managedGitWorkspace = new ManagedGitWorkspaceService(deps.workspaceStore);
    this.dispatchItemRepo = new KernelDispatchItemRepo(deps.db);
    this.publicationRepo = new WorkspacePublicationRepo(deps.db);
    this.resultObjectRepo = new ResultObjectRepo(
      deps.db,
      deps.resultRoot,
    );
    this.terminalService = new AttemptTerminalService(deps.db, {
      ...(deps.accountId === undefined ? {} : { accountId: deps.accountId }),
      subtaskRepo: deps.subtaskRepo,
      handoffRepo: this.handoffRepo,
      results: this.resultObjectRepo,
    });
  }

  private get sessionId(): string {
    return this.deps.getSessionId?.() ?? this.deps.sessionId;
  }

  supportsEvidenceTools(binding: AuthorizedExecutorBinding): boolean {
    return this.deps.executionRuntime.supportsEvidenceTools(binding);
  }

  supportsResponseOnly(
    agentClassName: string,
    configurationRevision: string,
  ): boolean {
    return this.deps.executionRuntime.supportsResponseOnly(
      agentClassName,
      configurationRevision,
    );
  }

  supportsContinuation(
    agentClassName: string,
    configurationRevision: string,
  ): boolean {
    return this.deps.executionRuntime.supportsContinuation(
      agentClassName,
      configurationRevision,
    );
  }

  /** User acceptance substitutes certification only; file/security checks and publication remain mandatory. */
  async stageAcceptedResult(expected: PendingResultIdentity): Promise<void> {
    const publicationId = `publication_accepted_${expected.attemptId}`;

    const assertCurrent = () => {
      const pending = readPendingTaskResult(this.deps.db, expected.taskId);
      const keys: Array<keyof PendingResultIdentity> = ['taskId', 'generationId', 'graphRevision', 'subtaskId', 'attemptId', 'resultId'];
      const accepted = Boolean(this.deps.db.prepare(`
        SELECT 1 FROM task_state_changes
        WHERE task_id = ? AND operation_key = ? LIMIT 1
      `).get(expected.taskId, `accept_result:${expected.attemptId}:${expected.resultId}`));
      // TaskStateAuthority removes an accepted result from the pending-action
      // projection immediately. The exact operation key is the durable fence
      // that permits publication to continue after that decision.
      if ((!pending && !accepted) || (pending && keys.some(key => pending[key] !== expected[key]))) {
        throw new Error('该结果操作已过期，请刷新任务后重试。');
      }
    };
    const existing = this.publicationRepo.find(publicationId);
    const existingConversationBinding = this.deps.conversationWorktrees?.repo.binding(
      expected.taskId,
      expected.generationId,
    ) ?? null;
    if (!existing) assertCurrent();
    const receipt = this.receiptRepo.findByAttemptId(expected.attemptId);
    if (!receipt) throw new Error('结果归属校验失败');
    const pair = resolveSafeResult({ accountId: this.deps.accountId ?? 'local-default', receipt,
      findObject: id => this.resultObjectRepo.findObject(id), findReceipt: id => this.receiptRepo.findByAttemptId(id) });
    if (!pair || pair.resultObjectId !== expected.resultId) throw new Error('结果归属校验失败');
    if (existing) {
      if (existing.taskId !== expected.taskId || existing.generationId !== expected.generationId
        || existing.subtaskId !== expected.subtaskId || receipt.graphRevision !== expected.graphRevision) {
        throw new Error('该结果操作已过期，请刷新任务后重试。');
      }
      // A previous build could have staged a Conversation Git result as a
      // legacy publication. Re-enter the acceptance path so it is converted
      // to direct completion; the operation remains idempotent.
      if (!existingConversationBinding) return;
    }
    const sourceRuntime = this.attemptRuntimeRepo.find(pair.resultOwnerAttemptId);
    const subtask = this.deps.subtaskRepo.findById(expected.subtaskId)!;
    const acceptedTask = this.deps.taskRuntimeService.findTask(expected.taskId);
    const acceptedBinding = existingConversationBinding
      ?? this.deps.conversationWorktrees?.repo.binding(expected.taskId, expected.generationId)
      ?? null;
    const acceptedRead = acceptedBinding
      && this.deps.conversationWorktrees!.repo.operationRecord(`read_${pair.resultOwnerAttemptId}`);
    const acceptedReadCommit = acceptedRead
      ? this.deps.conversationWorktrees!.readResultCommit(acceptedBinding!, pair.resultOwnerAttemptId) : null;
    let rootPath: string;
    let delta = parseWorkspaceDelta(sourceRuntime?.workspaceDelta);
    if (acceptedReadCommit) {
      rootPath = acceptedBinding!.executionRoot;
      if (!delta) throw new Error('read_only_result_delta_missing');
    } else {
      // Conversation Git Attempts execute directly in the durable session
      // Worktree. The legacy workspace record points at the Attempt-owned
      // `.metawork-tmp` scratch directory, which is intentionally removed after
      // the Attempt settles. Result acceptance must therefore resolve the
      // immutable Conversation binding first and never resurrect that scratch
      // path as the source of truth.
      if (acceptedBinding) {
        rootPath = acceptedBinding.executionRoot;
        try {
          statSync(rootPath);
        } catch {
          throw new Error('结果工作区不可用');
        }
      } else {
        const workspace = this.deps.workspaceRepository.findByIdentity(expected.taskId, expected.generationId, expected.subtaskId);
        if (!workspace?.rootUri.startsWith('file:')) throw new Error('结果工作区不可用');
        rootPath = join(fileURLToPath(workspace.rootUri), 'files');
      }
      if (!delta) throw new Error('无法确认文件变更，结果尚不能交付');
      const baseline = parseWorkspaceState(sourceRuntime?.workspaceBaseline);
      if (!baseline || delta.baselineTruncated || delta.finalTruncated) throw new Error('文件快照不完整，无法接受');
      const currentDelta = deriveWorkspaceDelta(baseline, captureWorkspaceState(rootPath));
      if (JSON.stringify(currentDelta) !== JSON.stringify(delta)) throw new Error('结果生成后文件已变化，请重新执行并检查');
    }
    const body = this.resultObjectRepo.readRange(pair.object.resultId, 0, pair.object.byteLength).content;
    const subtasks = this.deps.subtaskRepo.listActiveByTask(expected.taskId);
    const outgoingHandoffs = subtasks.flatMap(candidate => {
      const edge = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
      return edge ? [{ toSubtaskId: candidate.id, requiredItems: edge.requiredItems }] : [];
    });
    const completion = validateCompletionProtocol({ subtask, outgoingHandoffs,
      workspaceRoot: rootPath, workspaceDelta: delta,
      rawResponse: `${body}\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
        evidence: ['用户明确接受当前结果'], noChangeReason: delta.changed.length ? null : '用户接受现有结果，无文件变更',
      })}` });
    if (!completion.ok || completion.assessment.safety.status !== 'safe'
      || completion.assessment.deliverability.status !== 'deliverable'
      || completion.assessment.certification.violations.some(item => item.code !== 'completion_acceptance_mismatch')) {
      throw new Error('文件、安全或下游交付检查失败，结果尚不能发布');
    }
    const candidate = acceptedReadCommit
      ? {commit: acceptedReadCommit}
      : acceptedBinding
        ? {commit: this.deps.conversationWorktrees!.settledWriteCommit(pair.resultOwnerAttemptId)}
        : await this.managedGitWorkspace.commit(
          await this.managedGitWorkspace.ensure({ taskId: expected.taskId,
            generationId: expected.generationId, subtaskId: expected.subtaskId },
          this.requireSourceRoot('accepted result')),
          `fix: publish accepted ${subtask.id} result`,
        );
    if (acceptedBinding) {
      const edgeHandoffs = {
        generationId: subtask.generationId,
        completionSchemaVersion: 4 as const,
        declaredHandoffs: completion.envelope?.status === 'completed' ? completion.envelope.handoffs : [],
        safeProjection: safeProjectionForEdgeHandoffs(
          this.resultObjectRepo,
          pair.resultObjectId,
          body,
        ),
      };
      assertEdgeHandoffsMaterializable(
        { subtaskRepo: this.deps.subtaskRepo },
        { taskId: expected.taskId, subtaskId: expected.subtaskId },
        edgeHandoffs.safeProjection,
      );
      this.deps.db.transaction(() => {
        assertCurrent();
        this.lifecycle.transitionSubtask({
          subtaskId: subtask.id,
          to: 'done',
          actor: 'subtask-attempt-runner',
          reason: 'accepted result completed directly in Conversation Worktree',
          changes: {
            result: body,
            artifacts: completion.normalizedArtifacts,
            verification: { warnings: completion.warnings, completionSchemaVersion: 4 },
            error: null,
          },
        });
        materializeOutgoingHandoffs(
          {
            accountId: this.deps.accountId,
            subtaskRepo: this.deps.subtaskRepo,
            handoffRepo: this.handoffRepo,
            results: this.resultObjectRepo,
          },
          {
            taskId: expected.taskId,
            subtaskId: expected.subtaskId,
            generationId: subtask.generationId,
            attemptId: expected.attemptId,
            completionSchemaVersion: 4,
            declaredHandoffs: edgeHandoffs.declaredHandoffs,
          },
          edgeHandoffs.safeProjection,
          new Date().toISOString(),
        );
      }).immediate();
      return;
    }
    const dispatch = this.dispatchItemRepo.find(expected.attemptId)!;
    this.deps.db.transaction(() => {
      assertCurrent();
      this.publicationRepo.insertCandidate({ id: publicationId, taskId: expected.taskId,
        generationId: expected.generationId, subtaskId: expected.subtaskId, sourceAttemptId: expected.attemptId,
        agentClassName: receipt.agentClassName, candidateCommit: candidate.commit,
        completion: { body, artifacts: completion.normalizedArtifacts, warnings: completion.warnings,
          handoffs: completion.envelope?.status === 'completed' ? completion.envelope.handoffs : [], completionSchemaVersion: 4 },
        topologyLayer: deriveTopologyLayer(subtask.id, subtasks), firstDispatchOrder: dispatch.batchOrder,
        createdAt: new Date().toISOString() });
      this.lifecycle.transitionSubtask({ subtaskId: subtask.id, to: 'awaiting_integration',
        actor: 'subtask-attempt-runner', reason: 'user accepted result; publication and delivery still required', changes: { error: null } });
    }).immediate();
  }

  landHeartbeatLost(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
  } & AuthorizedAttemptIdentity): void {
    const dispatch = this.requireAuthorizedDispatch(input);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!subtask || subtask.status === 'done' || this.receiptRepo.findByAttemptId(input.attemptId)) return;
    if (this.attemptRuntimeRepo.hasUnpersistedWrite(input.attemptId)) {
      // The process vanished after writing user bytes. A heartbeat-lost receipt
      // would present that as an ordinary retryable failure, so the Attempt is
      // left `uncertain`: recovery may only observe and fence, never replay.
      this.dispatchItemRepo.markUncertain(
        input.attemptId,
        'Attempt wrote to the Workspace and lost its heartbeat before persisting a receipt',
        new Date().toISOString(),
      );
      return;
    }
    const now = new Date().toISOString();
    const failure = {
      kind: 'heartbeat_lost' as const,
      scope: 'agent_class' as const,
      code: 'heartbeat_lost',
      summary: 'WorkUnit lease expired before a terminal observation',
    };
    this.terminalService.land({
      receipt: buildReceipt({
        ...input,
        startedAt: now,
        terminalState: 'heartbeat_lost',
        rawResponse: '',
        agentClassName: dispatch.authorizedBinding.agentClassRef,
        errorCode: 'heartbeat_lost',
        errorDetail: 'WorkUnit lease expired before a terminal observation',
        failure,
      }, now),
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: 'WorkUnit heartbeat lost',
      event: {
        schemaVersion: 5,
        configurationRevision: dispatch.configurationRevision,
        type: 'execution_outcome',
        id: `event_${dispatch.attemptId}_execution_outcome`,
        correlationId: dispatch.decisionId,
        causationId: dispatch.decisionId,
        occurredAt: now,
        sessionId: this.sessionId,
        taskId: dispatch.taskId,
        subtaskId: dispatch.subtaskId,
        attemptId: dispatch.attemptId,
        terminalKind: 'failed',
        authorizedBinding: dispatch.authorizedBinding,
        bindingFingerprint: dispatch.bindingFingerprint,
        attemptKind: dispatch.attemptKind,
        sourceAttemptId: dispatch.sourceAttemptId,
        failure,
      },
      now,
    });
  }

  async run(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    executionMode: ExecutionMode;
    attemptKind?: KernelAttemptKind;
    attemptPayload?: KernelAttemptPayload;
    sourceAttemptId?: string | null;
    recoveryMode?: KernelRecoveryMode;
    sourceRoot?: string;
    defaultResourceGrant: ResourceClaim[];
    onProgress?: ProgressCallback;
    queryId?: string | null;
  } & AuthorizedAttemptIdentity): Promise<SubtaskAttemptOutcome> {
    const attemptId = input.attemptId;
    const dispatch = this.requireAuthorizedDispatch(input);
    const agentClassName = dispatch.authorizedBinding.agentClassRef;
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const sourceRoot = input.sourceRoot ?? this.deps.sourceRoot;
    if (sourceRoot && sourceRoot.endsWith('workspace-store')) {
      // The fallback sourceRoot is the workspace-store root itself; executing
      // from it imports the store into itself (observed 2026-09-03). Refuse
      // loudly instead — the dispatch payload's workspacePath was missing.
      throw new Error(
        `attempt ${attemptId} has no workspace source: dispatch payload is missing its workspacePath`,
      );
    }
    const originalSubtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const attemptKind = dispatch.attemptKind;
    const sourceAttemptId = dispatch.sourceAttemptId;
    const expectedStatus = attemptKind === 'primary' ? 'ready' : 'awaiting_decision';
    if (
      !task
      || !['running', 'queued', 'needs_action'].includes(task.status)
      || !originalSubtask
      || originalSubtask.taskId !== input.taskId
      || originalSubtask.status !== expectedStatus
    ) {
      return {
        outcome: 'cancelled_or_stale',
        attemptId,
        reason: `Task or ${expectedStatus} Subtask no longer matches the authorized ${attemptKind} attempt`,
      };
    }
    const conversationBinding = this.deps.conversationWorktrees?.repo.binding(input.taskId, originalSubtask.generationId) ?? null;
    const serviceRepair = dispatch.attemptPayload?.protocol === 'metawork:service-repair:v1'
      ? dispatch.attemptPayload
      : null;
    const servicePreparation = serviceRepair?.servicePreparation ?? null;
    const subtask = servicePreparation
      ? {...originalSubtask, deliveryKind: 'report' as const, fileOutputs: [], acceptance: [],
        goal: `Prepare service ${serviceRepair!.serviceId}. Install dependencies and build required runtime outputs in the assigned service worktree. Keep tracked source files unchanged. Do not repeat the original task or its handoffs. Report preparation results.`}
      : originalSubtask;
    if (!conversationBinding) throw new Error('legacy_execution_requires_replan');
    const conversationReadOnly = !servicePreparation
      && supportsSharedWorkspaceRead(subtask, this.deps.subtaskRepo.listByTask(task.id).filter(node => node.generationId === subtask.generationId));
    const sourceReceipt = sourceAttemptId
      ? this.receiptRepo.findByAttemptId(sourceAttemptId)
      : null;
    if (
      sourceAttemptId
      && (
        attemptKind === 'continuation'
        || (attemptKind as string) === 'merge_repair'
        || dispatch.recoveryMode === 'native_session'
      )
      // An uncertain source dispatch can exist without an immutable receipt:
      // the executor settled after the terminal fence changed. Kernel resume
      // has already revalidated the source dispatch identity, so allow the
      // recovery packet to rebuild from the durable workspace in that case.
      && sourceReceipt
      && !sameReceiptBinding(sourceReceipt, dispatch)
    ) {
      return {
        outcome: 'cancelled_or_stale',
        attemptId,
        reason: 'continuation binding does not match its source attempt',
      };
    }
    // The durable Conversation binding is the only authority for the mode,
    // Workspace identity and working directory. A dispatch whose fingerprint
    // disagrees with it is stale; there is no ambient or Task-row fallback.
    if (dispatch.executionBindingFingerprint !== conversationBinding.bindingFingerprint) {
      return { outcome: 'cancelled_or_stale', attemptId, reason: 'conversation binding fingerprint mismatch' };
    }
    await this.deps.conversationWorktrees!.validateBinding(conversationBinding);
    const serviceCheckout = servicePreparation
      ? await this.deps.serviceWorktrees?.resolvePreparation(input.taskId, serviceRepair!.serviceId, servicePreparation)
      : null;
    if (servicePreparation && !serviceCheckout) throw new Error('service_worktree_runtime_unavailable');
    const executionContext = serviceCheckout
      ? {
          ...executionContextFromConversation({binding:conversationBinding,
            subtaskId:subtask.id,attemptId,configurationRevision:dispatch.configurationRevision}),
          executionMode: 'service_git' as const,
          authorizedWorkingDirectory: serviceCheckout.rootPath,
          conversation: undefined,
          service: {serviceWorktreeId:serviceCheckout.serviceWorktreeId,sourceCommit:serviceCheckout.sourceCommit,projectPath:serviceCheckout.projectPath},
        }
      : executionContextFromConversation({binding:conversationBinding,
      subtaskId:subtask.id,attemptId,configurationRevision:dispatch.configurationRevision});
    const executionMode = executionContext.executionMode;
    const workspaceId = executionContext.workspaceId;
    if (attemptKind === 'merge_repair') {
      throw new Error('merge-repair Worktree attempts are retired; re-plan the edit in the target Workspace');
    }
    const conversationExecution = !serviceCheckout;
    const serviceExecution = Boolean(serviceCheckout);
    // The Git failure reason is kept for change-record diagnostics. A missing
    // Git channel falls back to bounded observation of the authorized targets;
    // only a missing target scope leaves the delta unavailable.
    let gitChannelFailure: WorkspaceCaptureFailure | null = null;
    const captureStateSafely = (
      root: string,
      targetPaths: readonly string[] = [],
      preferredSource?: WorkspaceState['source'],
    ): WorkspaceState | null => {
      if (preferredSource === 'filesystem') {
        return captureWorkspaceStateAtPaths(root, targetPaths);
      }
      try {
        return captureWorkspaceState(root);
      } catch (error) {
        gitChannelFailure = classifyWorkspaceCaptureFailure(error);
        if (targetPaths.length > 0) {
          // The Kernel has already pinned an authoritative, bounded target
          // scope. Capture those files directly whenever Git is unavailable
          // (ordinary directories, a missing Git binary, or a transient Git
          // command failure) so a healthy target edit does not become a
          // misleading empty delta and an unnecessary acceptance prompt.
          return captureWorkspaceStateAtPaths(root, targetPaths);
        }
        return null;
      }
    };
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: input.taskId,
      subtask: { id: subtask.id },
      authorizedBinding: dispatch.authorizedBinding,
      attemptId,
    }).catch(error => {
      if (error instanceof ExecutorProbeError) return error;
      throw error;
    });
    if (claim instanceof ExecutorProbeError) return { outcome: 'executor_unavailable', attemptId, failure: claim.failure };
    if (!claim) return { outcome: 'capacity_unavailable', attemptId, agentClassName };

    const readScratchRoot = conversationReadOnly ? this.deps.workspaceStore.planReadOnlyRoot(
      {taskId: task.id, generationId: subtask.generationId, subtaskId: subtask.id}, attemptId) : null;
    if (readScratchRoot && (isWithin(conversationBinding!.executionRoot, readScratchRoot)
      || isWithin(readScratchRoot, conversationBinding!.executionRoot))) {
      claim.release();
      throw new Error('read_scratch_overlaps_conversation');
    }
    const leaseToken = `attempt_lease_${randomUUID()}`;
    const claims = conversationExecution
      ? [...input.defaultResourceGrant.filter(grant=>!partitionCovers(workspaceRootClaim(conversationBinding!.userRoot).partition,grant.partition)
        && !partitionCovers(grant.partition,workspaceRootClaim(conversationBinding!.userRoot).partition)),workspaceRootClaim(conversationBinding!.executionRoot, conversationReadOnly ? 'read' : 'write'),
        ...(conversationReadOnly ? [workspaceRootClaim(readScratchRoot!, 'write')] : [])]
      : [...input.defaultResourceGrant.filter(grant=>!partitionCovers(workspaceRootClaim(conversationBinding!.userRoot).partition,grant.partition)
        && !partitionCovers(grant.partition,workspaceRootClaim(conversationBinding!.userRoot).partition)),workspaceRootClaim(serviceCheckout!.rootPath, 'write')];
    const resourceClaim = this.deps.resourceLeaseService.claim({
      taskId: input.taskId,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId: claim.workUnit.id,
      claims,
      leaseToken,
    });
    if (resourceClaim.type === 'conflict') {
      claim.release();
      return {
        outcome: 'partition_conflict',
        attemptId,
        claims,
        conflictingLeaseIds: resourceClaim.conflictingLeases.map(lease => lease.id),
      };
    }

    if (conversationExecution && !this.deps.conversationWorktrees!.repo.claimConversation(conversationBinding!.conversationId, task.id, leaseToken, {attemptId, access: conversationReadOnly ? 'read' : 'write'})) {
      this.deps.resourceLeaseService.release(attemptId, leaseToken); claim.release();
      if (this.deps.conversationWorktrees!.repo.conversationState(conversationBinding!.worktreeId).state === 'failed') {
        return {outcome: 'executor_failed', attemptId, error: 'conversation_requires_recovery',
          failure: {kind: 'unknown', scope: 'task', code: 'conversation_requires_recovery',
            summary: '共享输入发生意外变化，会话已停止执行，需检查工作区后恢复', attemptStarted: false}};
      }
      return {outcome: 'partition_conflict', attemptId, claims, conflictingLeaseIds: []};
    }
    const startedAt = new Date().toISOString();
    let rawResponse = '';
    const rawResultWriter = this.resultObjectRepo.createWriter({
      resultId: `result_${attemptId}_raw`,
      accountId: this.deps.accountId ?? 'local-default',
      taskId: task.id,
      generationId: subtask.generationId,
      sourceSubtaskId: subtask.id,
      attemptId,
      kind: 'raw_attempt_output',
      mediaType: 'application/x-anyfusion-harness-stream',
      retentionClass: 'task',
      createdAt: startedAt,
    });
    let evidenceCapability: { revoke(): void } | null = null;
    let evidenceToolServer: ExecutionEvidenceToolServer | null = null;
    let resultReferenceCapability: ScopedExecutionResultReferencePort | null = null;
    let workspaceBaseline: WorkspaceState | null = null;
    let workspaceDelta: WorkspaceDelta | null = null;
    let workspace: WorkspaceHandle | null = null;
    let gitWorkspace!: ManagedGitWorkspace;
    let mergeRepair: {
      publicationId: string;
      conflictChainId: string;
      conflictingPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    } | null = null;
    let capabilityToolServer: CapabilityRequestToolServer | null = null;
    let usageSpanId: string | null = null;
    let usageSpanClosed = false;
    const closeUsageSpan = (state: 'closed' | 'uncertain'): void => {
      if (!usageSpanId || usageSpanClosed || !this.deps.usageSpanCloser) return;
      try {
        this.deps.usageSpanCloser(usageSpanId, state, new Date().toISOString());
      } catch {
        // Metering persistence must not change the authorized execution result.
      } finally {
        usageSpanClosed = true;
      }
    };
    let finalCheckpointReason: 'success' | 'failure' | 'cancelled' = 'failure';
    let declaredTargetPaths: string[] = [];
    let observationRoot = executionContext.executionMode === 'service_git' ? executionContext.authorizedWorkingDirectory : executionContext.canonicalWorkspacePath;
    const heartbeat = setInterval(() => {
      claim.heartbeat();
      this.deps.resourceLeaseService.heartbeat(attemptId, leaseToken);
      if (conversationReadOnly && this.deps.conversationWorktrees!.repo.conversationState(conversationBinding!.worktreeId).state === 'failed') {
        this.deps.executionRuntime.abortTask(task.id);
      }
    }, 20_000);
    try {
      claim.startAttempt();
      if (conversationReadOnly) await this.deps.conversationWorktrees!.beginRead(conversationBinding!, attemptId, sourceAttemptId);
      if ((attemptKind as string) === 'merge_repair') {
        if (dispatch.attemptPayload?.protocol !== 'metaclaw:merge-repair:v1') {
          throw new Error('merge repair attempt is missing metaclaw:merge-repair:v1 payload');
        }
        if (!this.publicationRepo.recordRepairAttempt(
          dispatch.attemptPayload.publicationId,
          new Date().toISOString(),
        )) {
          throw new Error(`merge repair budget or publication state is stale: ${dispatch.attemptPayload.publicationId}`);
        }
      }
      this.lifecycle.transitionSubtask({
        subtaskId: subtask.id,
        to: 'running',
        actor: 'subtask-attempt-runner',
        reason: `attempt ${attemptId} claimed the Subtask`,
      });
      claim.markRunning();
      if (
        !this.deps.agentClassService.hasExecutorAgentClass(agentClassName)
        || claim.workUnit.agentClassName !== agentClassName
      ) {
        throw new Error(`attempt AgentClass mismatch: ${agentClassName}`);
      }
      const activeSubtasks = this.deps.subtaskRepo.listActiveByTask(input.taskId);
      const allSubtasks = activeSubtasks.length > 0 ? activeSubtasks : this.deps.subtaskRepo.listByTask(input.taskId);
      const workspaceIdentity = {
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
      };
      if (conversationReadOnly) {
        workspace = await this.deps.workspaceStore.bindReadOnlyWorkspace(workspaceIdentity, attemptId, 'conversation_git');
      } else {
        workspace = await this.deps.workspaceStore.bindConversationWorkspace(workspaceIdentity, executionContext.authorizedWorkingDirectory, attemptId);
      }
      if (!workspace) throw new Error('Workspace binding did not produce an execution directory');
      observationRoot = conversationReadOnly ? conversationBinding.executionRoot : workspace.filesPath;
      if (serviceRepair) {
        // The Kernel authorized exactly one repair round; the Attempt must not
        // run with a payload whose ordinal or service identity changed.
        if (attemptKind !== 'continuation' || !sourceAttemptId) {
          throw new Error('service repair payload changed after authorization');
        }
        if (serviceRepair.workspaceId
          && task.workspaceId
          && serviceRepair.workspaceId !== task.workspaceId) {
          throw new Error('service repair payload targets a different Workspace');
        }
      }
      if ((attemptKind as string) === 'merge_repair') {
        const payload = dispatch.attemptPayload;
        if (payload?.protocol !== 'metaclaw:merge-repair:v1') {
          throw new Error('merge repair payload changed after authorization');
        }
        const publication = this.publicationRepo.find(payload.publicationId);
        if (!publication || publication.status !== 'conflicted') {
          throw new Error(`merge repair publication is no longer conflicted: ${payload.publicationId}`);
        }
        const integrationWorkspace = await this.managedGitWorkspace.ensure({
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: '__integration__',
        }, sourceRoot);
        const description = await this.managedGitWorkspace.describeCandidate(
          integrationWorkspace,
          publication.candidateCommit,
        );
        const preparation = await this.managedGitWorkspace.prepareMergeRepair({
          candidateWorkspace: gitWorkspace!,
          integrationWorkspace,
          candidateCommit: publication.candidateCommit,
          expectedConflictPaths: payload.conflictingPaths,
          filePolicy: description.filePolicy,
        });
        mergeRepair = {
          publicationId: payload.publicationId,
          conflictChainId: payload.conflictChainId,
          conflictingPaths: preparation.conflictPaths,
          filePolicy: preparation.filePolicy,
        };
      }
      const workspaceNow = new Date().toISOString();
      this.deps.workspaceRepository.upsert({
        id: workspace.id,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        kind: 'git',
        rootUri: pathToFileURL(workspace.rootPath).href,
        baseline: gitWorkspace ? {
          sourceCommit: gitWorkspace.sourceCommit,
          baselineCommit: gitWorkspace.baselineCommit,
          sourceDiffHash: gitWorkspace.sourceDiffHash,
        } : {},
        managedRepositoryUri: gitWorkspace ? pathToFileURL(gitWorkspace.repositoryPath).href : null,
        managedBranch: gitWorkspace?.branch ?? null,
        headCommit: gitWorkspace?.headCommit ?? null,
        currentCheckpointId: null,
        status: 'active',
        cleanupAfter: null,
        createdAt: workspaceNow,
        updatedAt: workspaceNow,
      });
      await mkdir(join(workspace.filesPath, '.metaclaw', 'results'), { recursive: true });
      const inputsPath = join(workspace.rootPath, 'inputs');
      const handoffsPath = join(workspace.rootPath, 'handoffs');
      await Promise.all([mkdir(inputsPath, { recursive: true }), mkdir(handoffsPath, { recursive: true })]);
      await materializeImageTaskResources(task.resources, subtask, inputsPath);
      const targetPath = conversationReadOnly ? conversationBinding.executionRoot : workspace.filesPath;
      // Planner authorization is Workspace-relative and durable on the
      // Generation binding. The Executor context must receive those paths
      // resolved against the actual execution root; passing the whole root as
      // the only target silently widened the model's declared scope.
      declaredTargetPaths = serviceExecution
        ? []
        : task.workspaceTargetPaths
        ?? [];
      const executorTargetPaths = conversationReadOnly
        ? []
        : declaredTargetPaths.length > 0
        ? declaredTargetPaths.map(path => {
            if (!isWorkspaceRelativePath(path)) {
              throw new Error(`authorized Workspace target path is unsafe: ${path}`);
            }
            const resolved = resolve(targetPath, path);
            if (!isWithin(targetPath, resolved)) {
              throw new Error(`authorized Workspace target path escapes execution root: ${path}`);
            }
            return resolved;
          })
        // Legacy bindings had no target scope. Keep their isolated execution
        // runnable while schema-9 Tasks always carry at least one path.
        : [targetPath];
      const sourceRuntime = sourceAttemptId
        ? this.attemptRuntimeRepo.find(sourceAttemptId)
        : null;
      const currentWorkspaceBaseline = captureStateSafely(observationRoot, declaredTargetPaths);
      workspaceBaseline = (
        attemptKind === 'continuation' || attemptKind === 'fallback'
          ? recoveryChainWorkspaceBaseline({
              sourceRuntime,
              workspaceRoot: workspace.filesPath,
              findRuntime: sourceId => this.attemptRuntimeRepo.find(sourceId),
            })
          : null
      ) ?? currentWorkspaceBaseline;
      const recoveryMode: KernelRecoveryMode = serviceExecution ? 'recovery_packet' : dispatch.recoveryMode === 'native_session' && !sourceRuntime?.continuationToken
        ? 'recovery_packet'
        : dispatch.recoveryMode;
      this.attemptRuntimeRepo.start({
        attemptId,
        sourceAttemptId,
        // Read/execute Attempts use disposable scratch directories for inputs
        // and logs, but their authorized Workspace root is the canonical path.
        // Persist that root so correction/acceptance never points at a cleaned
        // scratch directory.
        workspaceRoot: observationRoot,
        workspaceBaseline: { ...(workspaceBaseline ?? { kind: 'git_status_v1', paths: {}, truncated: false }) },
        recoverySafety: deriveRecoverySafety(subtask.requiredCapabilities),
        now: startedAt,
      });
      this.attemptRuntimeRepo.appendProgress(attemptId, {
        kind: 'status',
        text: '工作区与输入资料已准备，正在生成 Executor 执行上下文',
      }, startedAt);
      const evidenceToolsAvailable = this.deps.executionRuntime.supportsEvidenceTools(dispatch.authorizedBinding);
      const attemptControlHost = this.deps.attemptExecutionBackend.pathMode === 'native'
        ? '127.0.0.1'
        : process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control';
      await this.materializeMemoryEvidence(task, subtask);
      const built = this.contextBuilder.build({
        executionId: input.executionId,
        task,
        subtask,
        allSubtasks,
        attemptId,
        workUnitId: claim.workUnit.id,
        sessionId: this.sessionId,
        workspaceContext: {
          allowFilesystem: true,
          workingDirectory: workspace.filesPath,
          targetPaths: executorTargetPaths,
          ...(workspaceId ? { workspaceId } : {}),
        executionMode: serviceExecution ? 'service_git' : 'conversation_git',
          ...(serviceExecution && serviceCheckout ? { service: {
            serviceId: serviceRepair?.serviceId,
            sourceTaskId: serviceCheckout.sourceTaskId,
            operationTaskId: task.id,
            sourceCommit: serviceCheckout.sourceCommit,
            serviceWorktreeId: serviceCheckout.serviceWorktreeId,
            projectPath: serviceCheckout.projectPath,
            specificationRevision: serviceRepair?.specificationRevision ?? null,
          } } : {}),
          // This is a Runtime filesystem/prompt boundary. Executor/Harness
          // chooses its tool registry independently; in particular, `read`
          // does not mean that a normal Attempt loses its shell tool.
          accessMode: conversationReadOnly ? 'read' : 'write',
          ...(conversationReadOnly ? { readOnlySourcePath: conversationBinding.executionRoot } : {}),
          canonicalRoot: executionContext.canonicalWorkspacePath,
        },
        inputFilesPath: inputsPath,
        evidenceToolsAvailable,
        servicePreparation: serviceExecution,
        currentSubtaskOverride: serviceExecution ? {
          title: `Prepare service ${serviceRepair!.serviceId}`,
          goal: `Prepare the service worktree at ${serviceCheckout!.rootPath}${serviceCheckout!.projectPath ? `/${serviceCheckout!.projectPath}` : ''} for source commit ${serviceCheckout!.sourceCommit}. Install dependencies and build runtime outputs as required by the existing project. Keep every tracked source file unchanged. Do not edit or generate deliverables for the original task. Report exact commands and results.`,
          deliveryKind: 'report',
          fileOutputs: [],
          acceptance: [],
        } : mergeRepair ? {
          title: `Repair merge conflicts for ${subtask.title}`,
          goal: buildMergeRepairGoal(
            subtask.goal,
            mergeRepair.conflictingPaths,
            gitWorkspace!.filesPath,
          ),
          deliveryKind: 'edit',
        } : undefined,
        completionContractOverride: mergeRepair ? {
          marker: MERGE_REPAIR_MARKER,
          protocol: MERGE_REPAIR_PROTOCOL,
          allowedPaths: mergeRepair.conflictingPaths,
        } : undefined,
        recovery: {
          mode: recoveryMode,
          sourceAttemptId,
          packet: recoveryMode === 'fresh'
            ? null
            : boundedRecoveryPacket(sourceReceipt, sourceRuntime, serviceRepair),
        },
      });
      evidenceCapability = built.evidenceCapability;
      resultReferenceCapability = built.resultReferenceCapability;
      this.attemptRuntimeRepo.appendProgress(attemptId, {
        kind: 'status',
        text: '执行上下文已生成，正在启动权限与能力服务',
      }, new Date().toISOString());
      if (evidenceToolsAvailable) {
        evidenceToolServer = new ExecutionEvidenceToolServer(
          built.evidenceCapability,
          built.resultReferenceCapability,
          { advertisedHost: attemptControlHost },
        );
        built.context.evidenceTools.binding = await evidenceToolServer.start();
      }
      const capabilityContext = {
        sessionId: this.sessionId,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        attemptId,
        agentClassName,
        configurationRevision: dispatch.configurationRevision,
        authorizedDecisionId: dispatch.decisionId,
        permissionProfileId: this.deps.executionRuntime.resolvePermissionProfile(
          dispatch.authorizedBinding,
        ),
        containerId: '',
        workspaceId: workspace.id,
        checkpointId: null as string | null,
      };
      const resourceRegistrations = new Map(task.resources.map((resource, index) => [
        resource,
        { kind: 'path' as const, mountId: `inputs-${task.id}`, normalizedRelativePath: `resource-${index}` },
      ]));
      const permissionWorkflow = new PermissionWorkflowService({
        context: capabilityContext,
        repository: this.deps.permissionRepository,
        resolver: new RegisteredCapabilityResourceResolver(resourceRegistrations),
        executionBackend: this.deps.attemptExecutionBackend,
        workflowStore: this.deps.kernelWorkflowStore,
        rules: buildPermissionRules({
          permissionProfileId: capabilityContext.permissionProfileId,
          additionalReadPartitions: resourceRegistrations.values(),
        }),
        hooks: {
          checkpoint: async () => {
            // Managed CAS checkpoints are reserved for private scratch roots.
            // Conversation Attempts author the bound Worktree directly and keep
            // their before/after change record as the recovery fact.
            return null;
          },
          onEscalation: async request => {
            claim.markWaiting(`permission request ${request.id} requires Planner or user review`);
            if (capabilityContext.containerId) await this.deps.attemptExecutionBackend.stop(capabilityContext.containerId);
          },
          onRecoveryAuthorized: async () => undefined,
        },
      });
      capabilityToolServer = new CapabilityRequestToolServer(permissionWorkflow, {
        advertisedHost: attemptControlHost,
      });
      const capabilityBinding = await capabilityToolServer.start();
      this.attemptRuntimeRepo.appendProgress(attemptId, {
        kind: 'status',
        text: '执行上下文已就绪，正在启动 Executor',
      }, new Date().toISOString());
      // Workspace and tool preparation yield; the durable fence may have won
      // before ExecutionRuntime has an adapter registered to abort.
      if (!this.isStillCurrent(task.id, subtask.id, attemptId, claim.workUnit.id)) {
        const detail = 'Task, Subtask, or WorkUnit claim changed before Executor launch';
        finalCheckpointReason = 'cancelled';
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'cancelled_or_stale', rawResponse,
          errorCode: 'attempt_cancelled', errorDetail: detail,
          resultObjects: this.persistAttemptResults({
            attemptId, taskId: task.id, generationId: subtask.generationId,
            subtaskId: subtask.id, rawResponse, body: null,
            completeness: 'incomplete', rawResultWriter,
          }),
        });
        if (this.isAttemptClaimCurrent(attemptId, claim.workUnit.id)) claim.markFailed(detail);
        return { outcome: 'cancelled_or_stale', attemptId, reason: detail };
      }
      const usageSourceId = `harness:${dispatch.authorizedBinding.harnessRef}:${input.attemptId}`;
      const usageCallId = `${input.attemptId}:harness`;
      if (input.queryId && this.deps.usageSpanOpener) {
        usageSpanId = `span_${usageSourceId}_${input.attemptId}`;
        this.deps.usageSpanOpener({
          spanId: usageSpanId,
          queryId: input.queryId,
          executionSegmentId: `attempt:${input.attemptId}`,
          sourceId: usageSourceId,
          sourceScope: 'harness_turn',
          callId: usageCallId,
          stage: 'execution',
          reason: (dispatch.attemptKind as string) === 'merge_repair' ? 'merge_repair' : 'primary',
          state: 'started',
          payer: this.deps.usagePayer ?? 'unknown',
          startedAt,
          closedAt: null,
        });
      }
      const execution = await this.deps.executionRuntime.run({
        taskId: input.taskId,
        executionId: input.executionId,
        authorizedBinding: dispatch.authorizedBinding,
        spec: { subtask, workUnit: claim.workUnit, acceptance: subtask.acceptance, deliveryKind: subtask.deliveryKind },
        executorInput: {
          context: built.context,
          executionBinding: {
            attemptId,
            taskId: task.id,
            generationId: subtask.generationId,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            leaseToken,
            idempotencyKey: `dispatch:${attemptId}`,
            workspacePath: workspace.filesPath,
            workspaceId: workspace.id,
            sourcePath: conversationReadOnly ? conversationBinding!.executionRoot : sourceRoot,
            inputsPath,
            handoffsPath,
            gitMetadataPath: gitWorkspace?.gitMetadataPath ?? null,
            controlNetwork: this.deps.controlNetwork,
            capabilityBinding,
            onExecutionCreated: containerId => {
              capabilityContext.containerId = containerId;
              this.dispatchItemRepo.markBackendExecution(attemptId, containerId, new Date().toISOString());
            },
          },
          recovery: {
            mode: recoveryMode,
            continuationToken: serviceExecution ? null : sourceRuntime?.continuationToken ?? null,
            onContinuationToken: token => this.attemptRuntimeRepo.recordContinuationToken(
              attemptId, token, new Date().toISOString(),
            ),
          },
          onRawOutput: chunk => rawResultWriter.append(chunk),
          onUsage: usage => this.observeUsage(input, dispatch, usage),
        },
        onProgress: (event, executor) => {
          const safeText = formatExecutorProgress(event.text);
          if (safeText && !event.operationHealth) {
            this.attemptRuntimeRepo.appendProgress(attemptId, {
              kind: event.kind,
              text: safeText,
            }, new Date().toISOString());
          }
          input.onProgress?.(event, executor);
        },
      });
      closeUsageSpan('closed');
      if (conversationReadOnly) await this.deps.conversationWorktrees!.finishRead(conversationBinding!, attemptId);
      this.attemptRuntimeRepo.recordWriteFinished(
        attemptId,
        'none',
        new Date().toISOString(),
      );
      if (execution.diagnostics) {
        this.attemptRuntimeRepo.recordDiagnostics(
          attemptId,
          execution.diagnostics,
          new Date().toISOString(),
        );
      }
      rawResponse = execution.output;
      const afterState = workspace
        ? captureStateSafely(observationRoot, declaredTargetPaths, workspaceBaseline?.source)
        : null;
      if (workspaceBaseline && workspace && afterState) {
        workspaceDelta = deriveWorkspaceDelta(
          workspaceBaseline,
          afterState,
        );
        this.attemptRuntimeRepo.recordWorkspaceDelta(
          attemptId,
          workspaceDelta,
          new Date().toISOString(),
        );
      }
      const capturedWritePaths = Array.isArray(execution.diagnostics?.workspaceCaptures)
        ? (execution.diagnostics.workspaceCaptures as string[])
        : [];
      if (execution.status !== 'success') {
        const error = execution.error ?? 'Executor failed without an error message';
        const pendingPermission = this.deps.permissionRepository.findPendingForTask(task.id);
        const executionFailure = pendingPermission?.request.attemptId === attemptId
          ? {
              kind: 'permission' as const,
              scope: 'attempt' as const,
              code: 'permission_escalated',
              summary: `permission request ${pendingPermission.request.id} requires Planner or user review`,
            }
          : execution.failure;
        const partialCompletion = execution.output.trim()
          ? validateCompletionProtocol({
              rawResponse: execution.output,
              subtask,
              outgoingHandoffs: [],
              workspaceRoot: observationRoot,
              workspaceDelta,
            })
          : null;
        const provisionalBody = (
          partialCompletion?.ok
          && partialCompletion.body
          && partialCompletion.assessment.deliverability.status === 'deliverable'
          && partialCompletion.assessment.safety.status === 'safe'
        ) ? partialCompletion.body : null;
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: execution.status === 'cancelled' ? 'cancelled_or_stale' : 'executor_failed', rawResponse,
          errorCode: execution.status === 'cancelled'
            ? 'attempt_cancelled'
            : executionFailure?.code ?? 'executor_failed',
          errorDetail: error,
          failure: executionFailure,
          resultObjects: this.persistAttemptResults({
            attemptId,
            taskId: task.id,
            generationId: subtask.generationId,
            subtaskId: subtask.id,
            rawResponse,
            body: provisionalBody,
            completeness: provisionalBody ? 'partial' : 'incomplete',
            rawResultWriter,
          }),
        });
        if (mergeRepair) {
          this.publicationRepo.recordRepairFailure(
            mergeRepair.publicationId,
            error,
            new Date().toISOString(),
          );
        }
        claim.markFailed(error);
        return execution.status === 'cancelled'
          ? { outcome: 'cancelled_or_stale', attemptId, reason: error }
          : {
              outcome: 'executor_failed', attemptId, error,
              failure: executionFailure ?? { kind: 'unknown', scope: 'attempt', code: 'executor_failed', summary: error },
            };
      }

      if (mergeRepair) {
        const report = parseMergeRepairReport(rawResponse);
        const repairedCommit = await this.managedGitWorkspace.commitMergeRepair({
          workspace: gitWorkspace!,
          allowedPaths: mergeRepair.conflictingPaths,
          filePolicy: mergeRepair.filePolicy,
          reportedResolvedPaths: report.resolvedPaths,
        });
        const completedAt = new Date().toISOString();
        const dispatchItem = this.dispatchItemRepo.find(attemptId);
        if (!dispatchItem) {
          throw new Error(`authorized dispatch item not found: ${attemptId}`);
        }
        const landing = this.terminalService.land({
          receipt: buildReceipt({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName,
            startedAt,
            terminalState: 'completed',
            rawResponse,
          }, completedAt),
          expectedSubtaskStatus: 'running',
          nextSubtaskStatus: 'awaiting_integration',
          subtaskError: null,
          repairPublication: {
            publicationId: mergeRepair.publicationId,
            candidateCommit: repairedCommit.commit,
          },
          event: {
            schemaVersion: 5,
            configurationRevision: dispatchItem.configurationRevision,
            type: 'execution_outcome',
            id: `event_${dispatchItem.attemptId}_execution_outcome`,
            correlationId: dispatchItem.decisionId,
            causationId: dispatchItem.decisionId,
            occurredAt: completedAt,
            sessionId: this.sessionId,
            taskId: dispatchItem.taskId,
            subtaskId: dispatchItem.subtaskId,
            attemptId: dispatchItem.attemptId,
            terminalKind: 'completed',
            authorizedBinding: dispatchItem.authorizedBinding,
            bindingFingerprint: dispatchItem.bindingFingerprint,
            attemptKind: dispatchItem.attemptKind,
            sourceAttemptId: dispatchItem.sourceAttemptId,
            failure: null,
          },
          now: completedAt,
        });
        if (landing.cancellationWon) {
          finalCheckpointReason = 'cancelled';
          return {
            outcome: 'cancelled_or_stale',
            attemptId,
            reason: 'Cancellation fence won before merge-repair terminal landing',
          };
        }
        const workspaceRecord = this.deps.workspaceRepository.findByIdentity(
          task.id,
          subtask.generationId,
          subtask.id,
        );
        if (workspaceRecord) {
          this.deps.workspaceRepository.upsert({
            ...workspaceRecord,
            headCommit: repairedCommit.workspaceCommit,
            status: 'active',
            updatedAt: completedAt,
          });
        }
        finalCheckpointReason = 'success';
        return {
          outcome: 'completed',
          attemptId,
          output: report.verificationSummary,
          artifacts: [],
          warnings: [],
          executorName: execution.executorName,
          durationMs: execution.durationMs,
        };
      }

      const outgoingHandoffs = serviceExecution ? [] : allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const completion = validateCompletionProtocol({
        rawResponse,
        subtask,
        outgoingHandoffs,
        workspaceRoot: conversationReadOnly ? conversationBinding.executionRoot : built.context.workspaceContext.workingDirectory,
        workspaceDelta,
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      const resultObjects = this.persistAttemptResults({
        attemptId,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        rawResponse,
        body: completion.body,
        completeness: completion.assessment.result.kind === 'complete' ? 'complete' : 'partial',
        rawResultWriter,
      });
      const safeBody = completion.body === null
        ? null
        : this.readResultObject(resultObjects.safeProjectionId, completion.body);
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        const contractOutcome = this.landContractFailure({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName,
          startedAt,
          rawResponse,
          completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
          violations: completion.violations,
          errorCode: completion.violations[0]?.code ?? 'completion_malformed',
          errorDetail: detail,
          completionContract: built.context.completionContract,
          assessment: completion.assessment,
          resultObjects,
        });
        claim.markFailed(detail);
        return contractOutcome;
      }
      if (
        completion.assessment.certification.status === 'uncertified'
        || completion.envelope === null
      ) {
        const violations = completion.assessment.certification.violations;
        const detail = violations.map(item =>
          `${item.code}:${item.path}:${item.message}`).join('; ')
          || 'completion metadata is incomplete';
        const contractOutcome = this.landContractFailure({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName,
          startedAt,
          rawResponse,
          completionSchemaVersion: completion.envelope?.schemaVersion ?? 4,
          violations,
          errorCode: violations[0]?.code ?? 'completion_malformed',
          errorDetail: detail,
          completionContract: built.context.completionContract,
          terminalState: 'uncertified_result',
          output: safeBody ?? undefined,
          assessment: completion.assessment,
          resultObjects,
        });
        claim.markWaiting('business result delivered; completion certification pending');
        return contractOutcome;
      }
      if (completion.envelope.status === 'failed') {
        const failure = completion.envelope.failure;
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse, completionSchemaVersion: 4,
          errorCode: failure.code, errorDetail: failure.summary,
          failure: { ...failure, scope: 'task' },
          resultObjects,
        });
        claim.markFailed(failure.summary);
        return {
          outcome: 'executor_failed', attemptId, error: failure.summary,
          failure: { ...failure, scope: 'task' },
        };
      }
      const completedEnvelope = completion.envelope;

      if (!this.isStillCurrent(task.id, subtask.id, attemptId, claim.workUnit.id)) {
        const detail = 'Task, Subtask, or WorkUnit claim changed before commit';
        this.persistNonSuccess({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName,
          startedAt,
          terminalState: 'cancelled_or_stale',
          rawResponse,
          errorCode: 'attempt_stale',
          errorDetail: detail,
          resultObjects,
        });
        if (this.isAttemptClaimCurrent(attemptId, claim.workUnit.id)) {
          claim.markFailed(detail);
        }
        return { outcome: 'cancelled_or_stale', attemptId, reason: 'attempt became stale before commit' };
      }

      const completedAt = new Date().toISOString();
      // A Conversation Git Attempt lands through its sealed commit, and a
      // report or zero-change round creates no publication at all.
      if (serviceExecution) await this.deps.serviceWorktrees!.markPrepared(serviceCheckout!);
      if (conversationReadOnly) await this.deps.conversationWorktrees!.verifyRead(conversationBinding!, attemptId);
      const conversationCommit = conversationExecution && !conversationReadOnly
        ? await this.deps.conversationWorktrees!.sealAttempt(conversationBinding!, attemptId, [...completion.normalizedArtifacts,...completedEnvelope.handoffs.flatMap(h=>h.items.flatMap(item=>item.type==='text'?[]:item.paths))].map(path=>isAbsolute(path)?relative(conversationBinding!.executionRoot,path):path))
        : null;
      const artifactPaths = [...completion.normalizedArtifacts,
        ...completedEnvelope.handoffs.flatMap(h => h.items.flatMap(item => item.type === 'text' ? [] : item.paths))];
      const fixedArtifacts = conversationCommit && conversationBinding && this.deps.userArtifactPublication
        && artifactPaths.length > 0
        ? await this.deps.userArtifactPublication.prepareGitArtifacts({
          git:this.deps.conversationWorktrees!.git,repositoryPath:this.deps.conversationWorktrees!.repo.root(conversationBinding.workspaceId)!.repositoryPath,
          commit:conversationCommit.commit,accountId:this.deps.accountId??'local-default',workspaceId:conversationBinding.workspaceId,
          taskId:task.id,attemptId,generationId:subtask.generationId,subtaskId:subtask.id,
          relativePaths:artifactPaths
            .map(path=>isAbsolute(path)?relative(conversationBinding!.executionRoot,path):path),
        }):null;
      const dispatchItem = this.dispatchItemRepo.find(attemptId);
      if (!dispatchItem) {
        throw new Error(`authorized dispatch item not found: ${attemptId}`);
      }
      // A completion that owes an outgoing edge must be able to hand its result
      // downstream. Failing here keeps the Subtask out of `done` instead of
      // stranding the dependent node with `missing_handoff` forever.
      const edgeHandoffInput = !serviceExecution
        ? {
            generationId: subtask.generationId,
            completionSchemaVersion: 4 as const,
            declaredHandoffs: completedEnvelope.handoffs,
            ...(fixedArtifacts && conversationBinding ? {
              artifactVersions: Object.fromEntries(completedEnvelope.handoffs.flatMap(h => h.items.flatMap(item =>
                item.type === 'text' ? [] : item.paths.map(path => {
                  const relativePath = isAbsolute(path) ? relative(conversationBinding.executionRoot, path) : path;
                  const version = fixedArtifacts.versions.find(v => v.relativePath === relativePath);
                  if (!version) throw new Error(`handoff_artifact_version_missing:${path}`);
                  return [path, version.artifactVersionId];
                })))),
            } : {}),
            safeProjection: safeProjectionForEdgeHandoffs(
              this.resultObjectRepo,
              resultObjects.safeProjectionId,
              safeBody,
            ),
          }
        : null;
      if (edgeHandoffInput) {
        assertEdgeHandoffsMaterializable(
          { subtaskRepo: this.deps.subtaskRepo },
          { taskId: task.id, subtaskId: subtask.id },
          edgeHandoffInput.safeProjection,
        );
      }
      const landing = this.terminalService.land({
        commitFacts:fixedArtifacts?.commit,
        receipt: buildReceipt({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName,
          startedAt,
          terminalState: 'completed',
          rawResponse,
          completionSchemaVersion: 4,
          warnings: completion.warnings,
          assessment: completion.assessment,
          resultObjects,
        }, completedAt),
        expectedSubtaskStatus: 'running',
        nextSubtaskStatus: 'awaiting_integration',
        subtaskError: null,
        ...(!serviceExecution ? {
          subtaskResult: safeBody ?? '',
          subtaskArtifacts: completion.normalizedArtifacts,
          subtaskVerification: {
            warnings: completion.warnings,
            completionSchemaVersion: 4,
          },
        } : {}),
        directCompletion: true,
        ...(edgeHandoffInput ? { edgeHandoffs: edgeHandoffInput } : {}),
        event: {
          schemaVersion: 5,
          configurationRevision: dispatchItem.configurationRevision,
          type: 'execution_outcome',
          id: `event_${dispatchItem.attemptId}_execution_outcome`,
          correlationId: dispatchItem.decisionId,
          causationId: dispatchItem.decisionId,
          occurredAt: completedAt,
          sessionId: this.sessionId,
          taskId: dispatchItem.taskId,
          subtaskId: dispatchItem.subtaskId,
          attemptId: dispatchItem.attemptId,
          terminalKind: 'completed',
          authorizedBinding: dispatchItem.authorizedBinding,
          bindingFingerprint: dispatchItem.bindingFingerprint,
          attemptKind: dispatchItem.attemptKind,
          sourceAttemptId: dispatchItem.sourceAttemptId,
          failure: null,
        },
        now: completedAt,
      });
      if (landing.cancellationWon) {
        finalCheckpointReason = 'cancelled';
        return {
          outcome: 'cancelled_or_stale',
          attemptId,
          reason: 'Cancellation fence won before attempt terminal landing',
        };
      }
      if (workspace) {
        this.deps.workspaceRepository.upsert({
          id: workspace.id,
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          kind: 'git',
          rootUri: pathToFileURL(workspace.rootPath).href,
          baseline: gitWorkspace ? {
            sourceCommit: gitWorkspace.sourceCommit,
            baselineCommit: gitWorkspace.baselineCommit,
            sourceDiffHash: gitWorkspace.sourceDiffHash,
          } : {},
          managedRepositoryUri: gitWorkspace ? pathToFileURL(gitWorkspace.repositoryPath).href : null,
          managedBranch: null,
          headCommit: conversationCommit?.commit ?? null,
          currentCheckpointId: null,
          status: 'active',
          cleanupAfter: null,
          createdAt: completedAt,
          updatedAt: completedAt,
        });
      }
      finalCheckpointReason = 'success';

      return {
        outcome: 'completed',
        attemptId,
        output: safeBody ?? '',
        artifacts: completion.normalizedArtifacts,
        warnings: completion.warnings,
        executorName: execution.executorName,
        durationMs: execution.durationMs,
        // A report (or a zero-change edit) has no Workspace publication to
        // carry its business result. Keep the safe projection on the
        // completed outcome so the Kernel can deliver it to the Conversation.
        resultId: resultObjects.safeProjectionId ?? undefined,
      };
    } catch (error) {
      if (conversationReadOnly && this.deps.conversationWorktrees!.repo.conversationState(conversationBinding!.worktreeId).state === 'failed') {
        this.deps.executionRuntime.abortTask(task.id);
      }
      const message = error instanceof Error ? error.message : String(error);
      const edgeHandoffFailure = error instanceof EdgeHandoffMaterializationError
        ? kernelFailure({
            kind: 'infrastructure',
            scope: 'task',
            code: error.code,
            summary: '完成结果无法交接给下游节点（系统问题）',
            detail: message,
            origin: 'kernel',
            stage: 'completion',
            retryable: false,
            attemptStarted: true,
            externalSideEffect: false,
          })
        : null;
      const dependencyFailure = !edgeHandoffFailure && isDependencyMaterializationError(message)
        ? normalizeDependencyMaterializationFailure(error, {
            sourceSubtaskId: subtask.dependencies[0]?.fromSubtaskId ?? null,
            targetSubtaskId: subtask.id,
            referenceId: extractReferenceId(message),
          })
        : null;
      const memoryFailure = error instanceof MemoryEvidenceMaterializationError
        ? kernelFailure({
            kind: 'capability_mismatch',
            scope: 'task',
            code: error.code,
            summary: '引用的记忆已变化或不可用，正在重新校验当前记忆快照',
            detail: message,
            origin: 'kernel',
            stage: 'context_preparation',
            retryable: false,
            attemptStarted: false,
            externalSideEffect: false,
          })
        : null;
      const normalizedFailure = edgeHandoffFailure ?? (dependencyFailure
        ? kernelFailure({
            kind: dependencyFailure.retryable ? 'infrastructure' : 'capability_mismatch',
            scope: 'task',
            code: dependencyFailure.code,
            summary: `${dependencyFailure.summary} (${dependencyFailure.sourceSubtaskId ?? 'unknown'} -> ${dependencyFailure.targetSubtaskId ?? subtask.id})`,
          })
        : memoryFailure ?? (error instanceof InteractionReferenceError || error instanceof ExecutionEvidenceIdentityError
          ? kernelFailure({
              kind: 'unknown',
              scope: 'task',
              code: error.code,
              summary: describeAttemptFailure({ failureCode: error.code })!,
              detail: message,
              origin: 'kernel',
              stage: 'context_preparation',
              retryable: false,
              attemptStarted: false,
            externalSideEffect: false,
          })
          : null));
      if (mergeRepair) {
        this.publicationRepo.recordRepairFailure(
          mergeRepair.publicationId,
          normalizedFailure?.summary ?? message,
          new Date().toISOString(),
        );
      }
      if (!this.receiptRepo.findByAttemptId(attemptId)) {
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'executor_failed',
          rawResponse,
          errorCode: normalizedFailure?.code ?? 'attempt_exception',
          errorDetail: normalizedFailure?.summary ?? message,
          failure: normalizedFailure,
          resultObjects: this.persistAttemptResults({
            attemptId,
            taskId: task.id,
            generationId: subtask.generationId,
            subtaskId: subtask.id,
            rawResponse,
            body: null,
            completeness: 'incomplete',
            rawResultWriter,
          }),
        });
      }
      claim.markFailed(normalizedFailure?.summary ?? message);
      return {
        outcome: 'executor_failed',
        attemptId,
        error: normalizedFailure?.summary ?? message,
        failure: normalizedFailure ?? {
          kind: 'unknown',
          scope: 'attempt',
          code: 'attempt_exception',
          summary: message,
        },
      };
    } finally {
      closeUsageSpan('uncertain');
      clearInterval(heartbeat);
      if (!workspaceDelta && workspaceBaseline && workspace) {
        try {
          const afterState = captureStateSafely(
            observationRoot,
            declaredTargetPaths,
            workspaceBaseline?.source,
          );
          if (afterState) {
            this.attemptRuntimeRepo.recordWorkspaceDelta(
              attemptId,
              deriveWorkspaceDelta(workspaceBaseline, afterState),
              new Date().toISOString(),
            );
          }
        } catch {
          // Failed attempts retain their terminal receipt even when best-effort delta capture fails.
        }
      }
      evidenceCapability?.revoke();
      resultReferenceCapability?.revoke();
      await evidenceToolServer?.close();
      await capabilityToolServer?.close();
      let workspaceSealed = true;
      if (conversationReadOnly && this.hasSealedTerminal(attemptId)
        && this.deps.conversationWorktrees!.repo.operationRecord(`read_${attemptId}`)) {
        try { await this.deps.conversationWorktrees!.finishRead(conversationBinding!, attemptId); }
        catch { this.deps.executionRuntime.abortTask(task.id); }
      }
      if (conversationExecution && !conversationReadOnly && this.hasSealedTerminal(attemptId) && this.deps.conversationWorktrees!.repo.operationRecord(`seal_${attemptId}`)?.state !== 'applied') {
        try { await this.deps.conversationWorktrees!.sealAttempt(conversationBinding!, attemptId); }
        catch { workspaceSealed = false; }
      }
      if (this.hasSealedTerminal(attemptId) && workspaceSealed) {
        if (conversationExecution) this.deps.conversationWorktrees!.repo.releaseConversation(conversationBinding!.conversationId, leaseToken);
        this.deps.resourceLeaseService.release(attemptId, leaseToken);
        claim.release();
        if (workspace && ((conversationExecution && !conversationReadOnly) || serviceExecution)) {
          await this.deps.workspaceStore.removeConversationScratch(workspace,executionContext.authorizedWorkingDirectory);
        } else if (workspace && conversationReadOnly) {
          // Inputs, handoffs and result staging belong to this read Attempt, not
          // to the user's Workspace. Once the terminal receipt is sealed they no
          // longer participate in recovery and can be retired safely.
          await this.deps.workspaceStore.removeWorkspaceUri(
            pathToFileURL(workspace.rootPath).href,
          ).catch(() => undefined);
        }
      }
    }
  }

  private observeUsage(
    input: { attemptId: string; executionId: string; taskId: string; subtaskId: string; queryId?: string | null },
    dispatch: KernelDispatchItemRecord,
    usage: HarnessUsageEvent,
  ): void {
    if (!input.queryId || !this.deps.usageObserver) return;
    const now = new Date().toISOString();
    this.deps.usageObserver({
      sourceId: `harness:${dispatch.authorizedBinding.harnessRef}:${input.attemptId}`,
      sourceEventKey: usage.sourceEventKey,
      sourceScope: 'harness_turn',
      callId: `${input.attemptId}:harness`,
      queryId: input.queryId,
      executionSegmentId: `attempt:${input.attemptId}`,
      taskId: input.taskId,
      stage: 'execution',
      reason: (dispatch.attemptKind as string) === 'merge_repair' ? 'merge_repair' : 'primary',
      payer: this.deps.usagePayer ?? 'unknown',
      agentClassRef: usage.agentClassRef ?? dispatch.authorizedBinding.agentClassRef,
      providerRef: usage.providerRef ?? dispatch.authorizedBinding.providerRef,
      modelId: usage.modelId ?? this.deps.executionRuntime.resolveModelId(dispatch.authorizedBinding),
      capturedAt: now,
      providerBindingVersion: dispatch.bindingFingerprint,
      evidenceRef: `attempt:${input.attemptId}`,
      counters: usage.counters,
      missing: usage.missing,
    });
  }

  async runCorrection(input: {
    attemptId: string;
    sourceAttemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    completionContract: unknown;
    violations: CompletionContractViolation[];
    sourceRoot?: string;
  } & AuthorizedAttemptIdentity): Promise<SubtaskAttemptOutcome> {
    const dispatch = this.requireAuthorizedDispatch(input);
    const agentClassName = dispatch.authorizedBinding.agentClassRef;
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const source = this.receiptRepo.findByAttemptId(input.sourceAttemptId);
    const sourceRuntime = this.attemptRuntimeRepo.find(input.sourceAttemptId);
    if (
      !task
      || !subtask
      || subtask.status !== 'awaiting_decision'
      || !source
      || !sourceRuntime
    ) {
      return { outcome: 'cancelled_or_stale', attemptId: input.attemptId, reason: 'response-only correction source is stale' };
    }
    if (
      dispatch.attemptKind !== 'contract_correction'
      || dispatch.sourceAttemptId !== input.sourceAttemptId
      || !sameReceiptBinding(source, dispatch)
    ) {
      return {
        outcome: 'cancelled_or_stale',
        attemptId: input.attemptId,
        reason: 'response-only correction binding does not match its source attempt',
      };
    }
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: task.id,
      subtask: { id: subtask.id },
      authorizedBinding: dispatch.authorizedBinding,
      attemptId: input.attemptId,
    }).catch(error => {
      if (error instanceof ExecutorProbeError) return error;
      throw error;
    });
    if (claim instanceof ExecutorProbeError) return { outcome: 'executor_unavailable', attemptId: input.attemptId, failure: claim.failure };
    if (!claim) return { outcome: 'capacity_unavailable', attemptId: input.attemptId, agentClassName };
    const startedAt = new Date().toISOString();
    try {
      claim.startAttempt();
      this.lifecycle.transitionSubtask({
        subtaskId: subtask.id,
        to: 'running',
        actor: 'subtask-attempt-runner',
        reason: `contract correction claimed the Subtask`,
      });
      claim.markRunning();
      const sourceResult = this.readCorrectionSourceResult(source);
      const sourceDelta = parseWorkspaceDelta(sourceRuntime.workspaceDelta);
      const workspaceChanged = Array.isArray(sourceDelta?.changed) && (sourceDelta?.changed?.length ?? 0) > 0;
      const prompt = buildCorrectionPrompt({
        resultId: sourceResult.safe.resultId,
        contentHash: sourceResult.safe.contentHash,
        byteLength: sourceResult.safe.byteLength,
        workspaceChanged,
        deliveryKind: subtask.deliveryKind,
        producedFiles: (sourceDelta?.changed ?? [])
          .filter(entry => entry.afterHash !== null)
          .map(entry => entry.path),
        sourceBodyPresent: Boolean(sourceResult.body),
        violations: input.violations,
      });
      const result = await this.deps.executionRuntime.runResponseOnly(
        dispatch.authorizedBinding,
        prompt,
        128 * 1024,
        input.attemptId,
      );
      if (!result?.success) {
        const error = result?.error ?? 'AgentClass does not enforce response-only correction';
        // An unavailable metadata repair must not hide the original safe
        // result. Bind this decision receipt to that exact source projection.
        const assessment = source.parsing.completionAssessment as CompletionAssessment;
        const outcome = this.landContractFailure({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'uncertified_result', rawResponse: result?.output ?? '',
          errorCode: 'correction_unavailable', errorDetail: '格式纠正未完成，请接受当前安全结果或重新执行',
          completionSchemaVersion: source.completionSchemaVersion, completionContract: input.completionContract,
          violations: input.violations, assessment, output: sourceResult.body,
          resultObjects: { rawOutputId: (source.parsing.resultObjects as AttemptResultObjects).rawOutputId,
            businessResultId: sourceResult.business.resultId, safeProjectionId: sourceResult.safe.resultId },
        });
        claim.markFailed(error);
        return outcome;
      }
      // A response-only correction may repair metadata safely without ever
      // touching the business result. For edit delivery with a zero-file
      // delta, the protocol requires a non-empty explanation. Models still
      // occasionally echo the report schema's `null` default, so fill only
      // that deterministic field before normal validation. This cannot hide
      // a malformed marker or any other contract violation.
      const correctedOutput = repairZeroChangeReason({
        output: result.output,
        workspaceChanged,
        deliveryKind: subtask.deliveryKind,
      });
      const activeSubtasks = this.deps.subtaskRepo.listActiveByTask(task.id);
      const allSubtasks = activeSubtasks.length > 0 ? activeSubtasks : this.deps.subtaskRepo.listByTask(task.id);
      const outgoingHandoffs = allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const correctionConversationBinding = this.deps.conversationWorktrees?.repo.binding(
        task.id,
        subtask.generationId,
      ) ?? null;
      if (!correctionConversationBinding) throw new Error('legacy_execution_requires_replan');
      const correctionWorkspaceRoot = correctionConversationBinding.executionRoot;
      if (!correctionWorkspaceRoot) {
        throw new Error(`response-only correction source workspace is unavailable: ${subtask.id}`);
      }
      const correctionMarkerIndex = correctedOutput.indexOf(COMPLETION_MARKER_V4);
      const correctedMetadata = correctionMarkerIndex >= 0
        ? correctedOutput.slice(correctionMarkerIndex)
        : correctedOutput;
      const completion = validateCompletionProtocol({
        rawResponse: `${sourceResult.body}\n\n${correctedMetadata}`,
        subtask,
        outgoingHandoffs,
        // Delta paths and reportPath are relative to the executor output area
        // (`files/` inside the bound Conversation Worktree).
        workspaceRoot: correctionWorkspaceRoot,
        workspaceDelta: sourceRuntime.workspaceDelta,
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      const correctionRaw = this.resultObjectRepo.putObject({
        resultId: `result_${input.attemptId}_raw`,
        accountId: this.deps.accountId ?? 'local-default',
        taskId: task.id,
        generationId: subtask.generationId,
        sourceSubtaskId: subtask.id,
        attemptId: input.attemptId,
        kind: 'raw_attempt_output',
        mediaType: 'text/plain',
        content: result.output,
        completeness: 'complete',
        retentionClass: 'task',
      });
      const resultObjects = {
        rawOutputId: correctionRaw.resultId,
        businessResultId: sourceResult.business.resultId,
        safeProjectionId: sourceResult.safe.resultId,
      };
      const safeBody = sourceResult.body;
      // When the source body is empty and the corrected trailer declares
      // reportPath, the validated workspace file is the authoritative body;
      // persist fresh result objects so downstream references never resolve
      // to an empty result.
      let activeResultObjects: {
        rawOutputId: string;
        businessResultId: string;
        safeProjectionId: string;
      } = resultObjects;
      let landedBody = safeBody;
      if (!safeBody && completion.ok && completion.body) {
        const resolved = this.persistAttemptResults({
          attemptId: input.attemptId,
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          rawResponse: correctedOutput,
          body: completion.body,
          completeness: 'complete',
        });
        if (resolved.businessResultId && resolved.safeProjectionId) {
          activeResultObjects = {
            rawOutputId: resolved.rawOutputId,
            businessResultId: resolved.businessResultId,
            safeProjectionId: resolved.safeProjectionId,
          };
          landedBody = completion.body;
        }
      }
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        const contractOutcome = this.landContractFailure({
          attemptId: input.attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName,
          startedAt,
          rawResponse: correctedOutput,
          completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
          violations: completion.violations,
          errorCode: completion.violations[0]?.code ?? 'completion_malformed',
          errorDetail: detail,
          completionContract: input.completionContract,
          assessment: completion.assessment,
          resultObjects,
        });
        claim.markFailed(detail);
        return contractOutcome;
      }
      if (
        completion.assessment.certification.status === 'uncertified'
        || completion.envelope === null
      ) {
        const violations = completion.assessment.certification.violations;
        const detail = violations.map(item =>
          `${item.code}:${item.path}:${item.message}`).join('; ')
          || 'completion metadata is incomplete';
        const contractOutcome = this.landContractFailure({
          attemptId: input.attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName,
          startedAt,
          rawResponse: result.output,
          completionSchemaVersion: completion.envelope?.schemaVersion ?? 4,
          violations,
          errorCode: violations[0]?.code ?? 'completion_malformed',
          errorDetail: detail,
          completionContract: input.completionContract,
          terminalState: 'uncertified_result',
          output: safeBody ?? undefined,
          assessment: completion.assessment,
          resultObjects,
        });
        claim.markWaiting('business result delivered; completion certification pending');
        return contractOutcome;
      }
      if (completion.envelope.status === 'failed') {
        const failure = completion.envelope.failure;
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: result.output, completionSchemaVersion: 4,
          errorCode: failure.code, errorDetail: failure.summary,
        });
        claim.markFailed(failure.summary);
        return {
          outcome: 'executor_failed', attemptId: input.attemptId, error: failure.summary,
          failure: { ...failure, scope: 'task' },
        };
      }
      const completedAt = new Date().toISOString();
      const dispatchItem = this.dispatchItemRepo.find(input.attemptId);
      if (!dispatchItem) {
        throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
      }
      // Re-reference the corrected result against the immutable Conversation
      // Git fact the source Attempt produced; a correction never creates a new
      // commit of its own.
      const sourceRead = this.deps.conversationWorktrees!.repo
        .operationRecord(`read_${input.sourceAttemptId}`);
      if (sourceRead) {
        this.deps.conversationWorktrees!.readResultCommit(
          correctionConversationBinding, input.sourceAttemptId, input.attemptId);
      } else {
        this.deps.conversationWorktrees!.settledWriteCommit(input.sourceAttemptId,
          {attemptId: input.attemptId, workspaceId: correctionConversationBinding.workspaceId});
      }
      const correctionEdgeHandoffs = {
        generationId: subtask.generationId,
        completionSchemaVersion: 4 as const,
        declaredHandoffs: completion.envelope.handoffs,
        safeProjection: safeProjectionForEdgeHandoffs(
          this.resultObjectRepo,
          activeResultObjects.safeProjectionId,
          landedBody,
        ),
      };
      assertEdgeHandoffsMaterializable(
        { subtaskRepo: this.deps.subtaskRepo },
        { taskId: task.id, subtaskId: subtask.id },
        correctionEdgeHandoffs.safeProjection,
      );
      const landing = this.terminalService.land({
        subtaskResult: landedBody ?? '',
        subtaskArtifacts: completion.normalizedArtifacts,
        subtaskVerification: {
          warnings: completion.warnings,
          completionSchemaVersion: 4,
        },
        directCompletion: true,
        edgeHandoffs: correctionEdgeHandoffs,
        receipt: buildReceipt({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'completed', rawResponse: result.output, completionSchemaVersion: 4, warnings: completion.warnings,
          resultObjects: activeResultObjects,
          assessment: completion.assessment,
          completionContract: input.completionContract,
        }, completedAt),
        expectedSubtaskStatus: 'running',
        nextSubtaskStatus: 'awaiting_integration',
        subtaskError: null,
        event: {
          schemaVersion: 5,
          configurationRevision: dispatchItem.configurationRevision,
          type: 'execution_outcome',
          id: `event_${dispatchItem.attemptId}_execution_outcome`,
          correlationId: dispatchItem.decisionId,
          causationId: dispatchItem.decisionId,
          occurredAt: completedAt,
          sessionId: this.sessionId,
          taskId: dispatchItem.taskId,
          subtaskId: dispatchItem.subtaskId,
          attemptId: dispatchItem.attemptId,
          terminalKind: 'completed',
          authorizedBinding: dispatchItem.authorizedBinding,
          bindingFingerprint: dispatchItem.bindingFingerprint,
          attemptKind: dispatchItem.attemptKind,
          sourceAttemptId: dispatchItem.sourceAttemptId,
          failure: null,
        },
        now: completedAt,
      });
      if (landing.cancellationWon) {
        return {
          outcome: 'cancelled_or_stale',
          attemptId: input.attemptId,
          reason: 'Cancellation fence won before correction terminal landing',
        };
      }

      return {
        outcome: 'completed', attemptId: input.attemptId, output: landedBody ?? '',
        artifacts: completion.normalizedArtifacts, warnings: completion.warnings,
        executorName: agentClassName, durationMs: result.durationMs,
        resultId: activeResultObjects.safeProjectionId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.receiptRepo.findByAttemptId(input.attemptId)) {
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: '', errorCode: 'correction_exception', errorDetail: message,
        });
      }
      claim.markFailed(message);
      return {
        outcome: 'executor_failed', attemptId: input.attemptId, error: message,
        failure: { kind: 'unknown', scope: 'attempt', code: 'correction_exception', summary: message },
      };
    } finally {
      if (this.hasSealedTerminal(input.attemptId)) {
        claim.release();
      }
    }
  }

  /**
   * Materialize the long-term memory references of one Subtask into execution
   * evidence. Memory reaches an Executor only through this channel; it is never
   * spliced into the prompt (design §10).
   */
  private async materializeMemoryEvidence(task: Task, subtask: Subtask): Promise<void> {
    const service = this.deps.memoryEvidence;
    if (!service) return;
    const memoryIds = MemoryEvidenceService.collectMemoryRefs(subtask.contextRefs ?? []);
    if (!memoryIds.length) return;
    const result = await service.materialize({
      accountId: task.accountId ?? this.deps.accountId ?? 'local-default',
      taskId: task.id,
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      memoryIds,
    });
    if (result.failed.length) {
      const failure = result.failed[0]!;
      const code = failure.reason.match(/^([a-z][a-z0-9_]+)/u)?.[1] ?? 'memory_context_unavailable';
      throw new MemoryEvidenceMaterializationError(code, failure.memoryId);
    }
  }

  private isStillCurrent(taskId: string, subtaskId: string, attemptId: string, workUnitId: string): boolean {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const subtask = this.deps.subtaskRepo.findById(subtaskId);
    // A Task-level blocker can coexist with an already-authorized sibling
    // Attempt.  The Attempt owns the terminal result; a later blocker on the
    // Task must not turn a successful Executor exit into a stale result.  The
    // previous `running`-only check caused exactly that race: one branch
    // blocked the Task while another branch was still completing, so the
    // terminal fence rejected the valid result and left the Subtask stuck.
    return (task?.status === 'running' || task?.status === 'needs_action' || task?.status === 'queued')
      && subtask?.status === 'running'
      && this.deps.workUnitClaimService.isClaimCurrent(workUnitId, attemptId, 'running');
  }

  private isAttemptClaimCurrent(attemptId: string, workUnitId: string): boolean {
    return this.deps.workUnitClaimService.isClaimCurrent(workUnitId, attemptId);
  }

  private hasSealedTerminal(attemptId: string): boolean {
    if (!this.receiptRepo.findByAttemptId(attemptId)) return false;
    const dispatch = this.dispatchItemRepo.find(attemptId);
    return Boolean(dispatch && ['terminal', 'cancelled'].includes(dispatch.status));
  }

  private requireAuthorizedDispatch(
    input: {
      attemptId: string;
      taskId: string;
      subtaskId: string;
    } & AuthorizedAttemptIdentity,
  ): KernelDispatchItemRecord {
    const dispatch = this.dispatchItemRepo.find(input.attemptId);
    if (!dispatch) {
      throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
    }
    if (
      dispatch.taskId !== input.taskId
      || dispatch.subtaskId !== input.subtaskId
      || dispatch.configurationRevision !== input.authorizedBinding.configurationRevision
      || dispatch.bindingFingerprint !== authorizedExecutorBindingFingerprint(dispatch.authorizedBinding)
      || dispatch.bindingFingerprint !== input.bindingFingerprint
      || !sameAuthorizedBinding(dispatch.authorizedBinding, input.authorizedBinding)
    ) {
      throw new Error(`authorized dispatch binding mismatch: ${input.attemptId}`);
    }
    return dispatch;
  }

  private landContractFailure(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
    startedAt: string;
    rawResponse: string;
    completionSchemaVersion: number | null;
    violations: CompletionContractViolation[];
    errorCode: string;
    errorDetail: string;
    completionContract: unknown;
    terminalState?: 'contract_blocked' | 'uncertified_result';
    output?: string;
    assessment: CompletionAssessment;
    resultObjects?: AttemptResultObjects;
  }): Extract<SubtaskAttemptOutcome, { outcome: 'contract_failed' }> {
    const dispatch = this.dispatchItemRepo.find(input.attemptId);
    if (!dispatch) {
      throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
    }
    const now = new Date().toISOString();
    const terminalState = input.terminalState ?? 'contract_blocked';
    const receiptCount = this.receiptRepo.countByTerminal(
      input.taskId,
      input.subtaskId,
      terminalState,
    ) + 1;
    const responseBytes = Buffer.byteLength(input.rawResponse, 'utf8');
    const event = {
      schemaVersion: 5 as const,
      configurationRevision: dispatch.configurationRevision,
      type: 'execution_result_observed' as const,
      id: `event_${dispatch.attemptId}_execution_result_observed`,
      correlationId: dispatch.decisionId,
      causationId: dispatch.decisionId,
      occurredAt: now,
      sessionId: this.sessionId,
      taskId: dispatch.taskId,
      subtaskId: dispatch.subtaskId,
      attemptId: dispatch.attemptId,
      workUnitId: input.workUnitId,
      authorizedBinding: dispatch.authorizedBinding,
      bindingFingerprint: dispatch.bindingFingerprint,
      contract: input.completionContract,
      violations: input.violations,
      receiptCount,
      responseBytes,
      resultId: input.resultObjects?.safeProjectionId ?? null,
      deliverability: input.assessment.deliverability.status,
      certification: input.assessment.certification.status,
      safety: input.assessment.safety.status,
    };
    this.terminalService.land({
      receipt: buildReceipt({
        ...input,
        terminalState,
      }, now),
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: input.errorDetail,
      event,
      now,
    });
    return {
      outcome: 'contract_failed',
      attemptId: input.attemptId,
      workUnitId: input.workUnitId,
      agentClassName: input.agentClassName,
      responseBytes,
      receiptCount,
      completionContract: input.completionContract,
      violations: input.violations,
      output: input.output,
      resultId: input.resultObjects?.safeProjectionId ?? undefined,
      deliverability: input.assessment.deliverability.status,
      certification: input.assessment.certification.status,
      safety: input.assessment.safety.status,
    };
  }

  /**
   * Register attempt-output files as user-visible artifacts straight from the
   * executor output area — independent of the git publication ceremony, so
   * correction-path completions register too. Failure-isolated by design.
   */
  private persistAttemptResults(input: {
    attemptId: string;
    taskId: string;
    generationId: string;
    subtaskId: string;
    rawResponse: string;
    body: string | null;
    completeness: 'complete' | 'partial' | 'incomplete';
    rawResultWriter?: ResultObjectWriter;
  }): AttemptResultObjects {
    const common = {
      accountId: this.deps.accountId ?? 'local-default',
      taskId: input.taskId,
      generationId: input.generationId,
      sourceSubtaskId: input.subtaskId,
      attemptId: input.attemptId,
      retentionClass: 'task',
    };
    const raw = input.rawResultWriter
      ? (() => {
          if (input.rawResultWriter.byteLength === 0 && input.rawResponse) {
            input.rawResultWriter.append(input.rawResponse);
          }
          return input.rawResultWriter.finalize(input.completeness);
        })()
      : this.resultObjectRepo.putObject({
          ...common,
          resultId: `result_${input.attemptId}_raw`,
          kind: 'raw_attempt_output',
          mediaType: 'text/plain',
          content: input.rawResponse,
          completeness: input.completeness,
        });
    if (input.body === null) {
      return { rawOutputId: raw.resultId, businessResultId: null, safeProjectionId: null };
    }
    const business = this.resultObjectRepo.putObject({
      ...common,
      resultId: `result_${input.attemptId}_business`,
      kind: 'business_result',
      mediaType: 'text/markdown',
      content: input.body,
      completeness: input.completeness,
    });
    const safe = this.resultObjectRepo.putObject({
      ...common,
      resultId: `result_${input.attemptId}_safe`,
      kind: 'safe_projection',
      mediaType: 'text/markdown',
      content: publicText(input.body),
      completeness: input.completeness,
    });
    return {
      rawOutputId: raw.resultId,
      businessResultId: business.resultId,
      safeProjectionId: safe.resultId,
    };
  }

  private readCorrectionSourceResult(receipt: ExecutorAttemptReceipt): {
    body: string;
    business: NonNullable<ReturnType<ResultObjectRepo['findObject']>>;
    safe: NonNullable<ReturnType<ResultObjectRepo['findObject']>>;
  } {
    const refs = receipt.parsing.resultObjects as AttemptResultObjects | null | undefined;
    const business = refs?.businessResultId
      ? this.resultObjectRepo.findObject(refs.businessResultId)
      : null;
    const safe = refs?.safeProjectionId
      ? this.resultObjectRepo.findObject(refs.safeProjectionId)
      : null;
    if (!business || !safe) {
      throw new Error(`correction source has no persisted business result: ${receipt.attemptId}`);
    }
    return {
      body: this.resultObjectRepo.readRange(safe.resultId, 0, safe.byteLength).content,
      business,
      safe,
    };
  }

  private readResultObject(resultId: string | null, fallback: string): string {
    if (!resultId) return fallback;
    const object = this.resultObjectRepo.findObject(resultId);
    if (!object) return fallback;
    return this.resultObjectRepo.readRange(resultId, 0, object.byteLength).content;
  }

  private persistNonSuccess(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
    startedAt: string;
    terminalState: ExecutorAttemptReceipt['terminalState'];
    rawResponse: string;
    completionSchemaVersion?: number | null;
    errorCode: string;
    errorDetail: string;
    failure?: KernelFailure | null;
    resultObjects?: AttemptResultObjects;
  }): void {
    const dispatch = this.dispatchItemRepo.find(input.attemptId);
    if (!dispatch) {
      throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
    }
    const now = new Date().toISOString();
    const failure = input.terminalState === 'cancelled_or_stale'
      ? {
          kind: 'stale' as const,
          scope: 'attempt' as const,
          code: input.errorCode,
          summary: input.errorDetail,
        }
      : input.failure ?? {
          kind: 'unknown' as const,
          scope: 'attempt' as const,
          code: input.errorCode,
          summary: input.errorDetail,
        };
    this.terminalService.land({
      receipt: buildReceipt(input, now),
      expectedSubtaskStatus: 'running',
      nextSubtaskStatus: 'awaiting_decision',
      subtaskError: input.errorDetail,
      event: {
        schemaVersion: 5,
        configurationRevision: dispatch.configurationRevision,
        type: 'execution_outcome',
        id: `event_${dispatch.attemptId}_execution_outcome`,
        correlationId: dispatch.decisionId,
        causationId: dispatch.decisionId,
        occurredAt: now,
        sessionId: this.sessionId,
        taskId: dispatch.taskId,
        subtaskId: dispatch.subtaskId,
        attemptId: dispatch.attemptId,
        terminalKind: 'failed',
        authorizedBinding: dispatch.authorizedBinding,
        bindingFingerprint: dispatch.bindingFingerprint,
        attemptKind: dispatch.attemptKind,
        sourceAttemptId: dispatch.sourceAttemptId,
        failure,
      },
      now,
    });
  }
}

async function materializeImageTaskResources(
  taskResources: readonly string[],
  subtask: Subtask,
  inputsPath: string,
): Promise<void> {
  if (!subtask.requiredCapabilities.includes('image-editing')) return;
  const selectedResources = subtask.contextRefs.flatMap(ref =>
    ref.kind === 'task_resource' ? [ref.locator] : [],
  );
  const resources = [...new Set(selectedResources.length > 0 ? selectedResources : taskResources)];
  const artifactInputCount = subtask.contextRefs.filter(ref => ref.kind === 'artifact').length;
  await chmod(inputsPath, 0o755);
  for (const [index, locator] of resources.entries()) {
    if (!taskResources.includes(locator)) continue;
    if (!IMAGE_RESOURCE_EXTENSIONS.has(extname(locator).toLowerCase())) continue;
    const info = await lstat(locator).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const name = safeInputResourceName(
      basename(locator),
      artifactInputCount + index,
    );
    const destination = join(inputsPath, name);
    await copyFile(locator, destination);
    await chmod(destination, 0o644);
  }
}

const IMAGE_RESOURCE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

/**
 * Pairs the pre-execution tree baseline with a fresh post-execution snapshot.
 * A failure is reported as a channel failure so the record degrades instead of
 * pretending the Workspace did not change.
 */
function safeInputResourceName(name: string, index: number): string {
  const normalized = name.normalize('NFC')
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^\.{1,2}$/u, '_')
    .slice(-160);
  return `input-${String(index + 1).padStart(2, '0')}-${normalized || 'resource'}`;
}

function summarizeHandoffUsage(handoffs: Array<{ items: PersistedSubtaskHandoffItem[] }>): {
  textCharacters: number;
  artifactPaths: number;
} {
  let textCharacters = 0;
  let artifactPaths = 0;
  for (const handoff of handoffs) {
    for (const item of handoff.items) {
      if (item.type === 'text') textCharacters += item.value.length;
      else if (item.type === 'artifact') artifactPaths += item.paths.length;
    }
  }
  return { textCharacters, artifactPaths };
}

function sameReceiptBinding(
  receipt: ExecutorAttemptReceipt | null,
  dispatch: KernelDispatchItemRecord,
): boolean {
  return Boolean(
    receipt
    && receipt.configurationRevision === dispatch.configurationRevision
    && receipt.bindingFingerprint === dispatch.bindingFingerprint
    && sameAuthorizedBinding(receipt.authorizedBinding, dispatch.authorizedBinding),
  );
}

function sameAuthorizedBinding(
  left: AuthorizedExecutorBinding,
  right: AuthorizedExecutorBinding,
): boolean {
  return left.agentClassRef === right.agentClassRef
    && left.harnessRef === right.harnessRef
    && left.providerRef === right.providerRef
    && left.modelRef === right.modelRef
    && left.permissionProfileRef === right.permissionProfileRef
    && left.configurationRevision === right.configurationRevision;
}

function deriveTopologyLayer(subtaskId: string, subtasks: Subtask[]): number {
  const byId = new Map(subtasks.map(subtask => [subtask.id, subtask]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`cyclic Subtask dependency while deriving topology layer: ${id}`);
    visiting.add(id);
    const subtask = byId.get(id);
    const layer = subtask
      ? subtask.dependencies.reduce((maximum, dependency) => (
          Math.max(maximum, visit(dependency.fromSubtaskId) + 1)
        ), 0)
      : 0;
    visiting.delete(id);
    memo.set(id, layer);
    return layer;
  };
  return visit(subtaskId);
}

function buildMergeRepairGoal(
  originalGoal: string,
  conflictingPaths: string[],
  workspacePath: string,
): string {
  return [
    'Resolve only the authorized Git merge conflicts. Do not change the original acceptance criteria, handoffs, or unrelated paths.',
    `Original Subtask goal (context only): ${originalGoal}`,
    `Writable conflict paths: ${conflictingPaths.join(', ')}`,
    `Read-only base/ours/theirs materials: ${join(workspacePath, '.metaclaw', 'merge-repair')}`,
    'For binary conflicts, regenerate exactly one target file from the supplied read-only versions.',
    'Runtime owns Git operations. Do not run git merge, git add, git commit, checkout, reset, or edit .git.',
    'Follow the dedicated merge-repair completion protocol in the execution context.',
  ].join('\n');
}

function buildReceipt(input: {
  attemptId: string;
  executionId: string;
  taskId: string;
  subtaskId: string;
  workUnitId: string;
  agentClassName: string;
  startedAt: string;
  terminalState: ExecutorAttemptReceipt['terminalState'];
  rawResponse: string;
  completionSchemaVersion?: number | null;
  warnings?: string[];
  violations?: CompletionContractViolation[];
  errorCode?: string | null;
  errorDetail?: string | null;
  failure?: KernelFailure | null;
  resultObjects?: AttemptResultObjects;
  assessment?: CompletionAssessment;
  completionContract?: unknown;
  responseBytes?: number;
}, completedAt = new Date().toISOString()): ExecutorAttemptReceiptInsert {
  return {
    attemptId: input.attemptId,
    executionId: input.executionId,
    taskId: input.taskId,
    subtaskId: input.subtaskId,
    workUnitId: input.workUnitId,
    agentClassName: input.agentClassName,
    startedAt: input.startedAt,
    completedAt,
    terminalState: input.terminalState,
    rawResponse: input.resultObjects ? '' : input.rawResponse,
    completionSchemaVersion: input.completionSchemaVersion ?? null,
    parsing: {
      completionMarker: input.completionSchemaVersion ? 'parsed' : 'unavailable',
      resultObjects: input.resultObjects ?? null,
      completionAssessment: input.assessment ?? null,
      completionContract: input.completionContract ?? null,
      responseBytes: input.responseBytes ?? Buffer.byteLength(input.rawResponse, 'utf8'),
    },
    verification: { warnings: input.warnings ?? [], violations: input.violations ?? [] },
    errorCode: input.errorCode ?? null,
    errorDetail: input.errorDetail ?? null,
    failure: input.failure ?? null,
  };
}

interface AttemptResultObjects {
  rawOutputId: string;
  businessResultId: string | null;
  safeProjectionId: string | null;
}

function buildCorrectionPrompt(input: {
  resultId: string;
  contentHash: string;
  byteLength: number;
  workspaceChanged: boolean;
  deliveryKind: Subtask['deliveryKind'];
  producedFiles: string[];
  sourceBodyPresent: boolean;
  violations: CompletionContractViolation[];
}): string {
  const guidance = [...new Set(input.violations.map(violation => correctionGuidance(violation.code)))];
  const zeroChangeEdit = input.deliveryKind === 'edit' && !input.workspaceChanged;
  const noChangeReasonExample = zeroChangeEdit
    ? '"noChangeReason":"已完成结果检查，但本次修正未产生新的文件变更"'
    : '"noChangeReason":null';
  return [
    'Repair only completion metadata. Do not execute the task, use tools, inspect files, change the workspace, or rewrite the business result.',
    'The immutable business result is not included in this prompt. Return exactly one completion trailer and no business body.',
    `Immutable result reference: ${input.resultId}`,
    `Immutable result hash: ${input.contentHash}`,
    `Immutable result bytes: ${input.byteLength}`,
    `Workspace changed: ${String(input.workspaceChanged)}`,
    `Source body present: ${String(input.sourceBodyPresent)}`,
    ...(input.producedFiles.length > 0
      ? [`Files produced by the source attempt (reportPath must be one of these when the body is empty): ${input.producedFiles.map(file => `"${file}"`).join(', ')}`]
      : ['The source attempt produced no workspace files; omit reportPath.']),
    `Trailer marker: ${COMPLETION_MARKER_V4}`,
    `Successful report schema: {"evidence":["<evidence>"],${noChangeReasonExample},"reportPath":"<optional: workspace file that is the authoritative body when the body is empty>"}`,
    ...(zeroChangeEdit
      ? ['This is an edit delivery with zero workspace changes. noChangeReason is required: return a concise non-empty reason string; never return null.']
      : input.deliveryKind === 'edit'
        ? ['This is an edit delivery with workspace changes. noChangeReason must be null.']
        : []),
    'Failure report schema: {"failure":{"kind":"task_failed","code":"<stable_code>","summary":"<concise explanation>"}}',
    'Do not return schema/status identity, Task/Subtask/attempt/WorkUnit IDs, acceptance keys, or handoff identities. Runtime owns and injects them.',
    `Validation guidance:\n${guidance.map(item => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

function repairZeroChangeReason(input: {
  output: string;
  workspaceChanged: boolean;
  deliveryKind: Subtask['deliveryKind'];
}): string {
  if (input.workspaceChanged || input.deliveryKind !== 'edit') return input.output;
  const markerIndex = input.output.indexOf(COMPLETION_MARKER_V4);
  if (markerIndex < 0) return input.output;
  const prefix = input.output.slice(0, markerIndex + COMPLETION_MARKER_V4.length);
  const metadata = input.output.slice(markerIndex + COMPLETION_MARKER_V4.length);
  return prefix + metadata.replace(
    /("noChangeReason"\s*:\s*)(null|"")/u,
    '$1"已完成结果检查，但本次修正未产生新的文件变更"',
  );
}

function correctionGuidance(code: CompletionContractViolation['code']): string {
  switch (code) {
    case 'completion_artifact_invalid':
      return 'Do not declare artifact paths; Runtime derives changed files from the authoritative workspace delta.';
    case 'completion_no_change_reason_mismatch':
      return 'Use null when files changed; for a zero-change edit provide a concise non-empty reason. Workspace changes are allowed for report delivery.';
    case 'completion_report_workspace_changed':
      return 'This is a historical validation code. New attempts allow Workspace changes for report delivery.';
    case 'completion_workspace_delta_uncertain':
      return 'The workspace delta is not authoritative and cannot be repaired in the response; return a structured failure.';
    case 'completion_malformed':
      return 'If the body was empty, declare reportPath in the trailer pointing to the report file this attempt wrote to the output area; otherwise return exactly one strict identity-free trailer matching the schemas above.';
    case 'completion_budget_exceeded':
      return 'Return valid metadata without changing or shortening the original business result.';
    default:
      return 'Return exactly one strict identity-free report matching one of the schemas above.';
  }
}

function isDependencyMaterializationError(message: string): boolean {
  return /(?:^|:)(?:dependency_|missing direct dependency workspace_state)/u.test(message)
    || message.includes('direct dependency workspace_state');
}

function extractReferenceId(message: string): string | null {
  const match = /(?:reference|Result Reference)\s+([A-Za-z0-9_.:-]+)/u.exec(message);
  return match?.[1] ?? null;
}

function boundedRecoveryPacket(
  receipt: ExecutorAttemptReceipt | null,
  runtime: ExecutorAttemptRuntimeRecord | null,
  serviceRepair?: Extract<KernelAttemptPayload, { protocol: 'metawork:service-repair:v1' }> | null,
): Record<string, unknown> {
  const packet = {
    sourceAttemptId: receipt?.attemptId ?? runtime?.attemptId ?? null,
    failure: serviceRepair
      // A service repair is not an executor failure: the Attempt succeeded and
      // the required service did not become healthy (2026-10-27 §4.3).
      ? {
          kind: serviceRepair.failure.kind,
          code: serviceRepair.failure.code,
          summary: serviceRepair.failure.summary,
          terminalState: 'service_verification_failed' as const,
        }
      : receipt ? {
        terminalState: receipt.terminalState,
        code: receipt.failure?.code ?? receipt.errorCode,
        // Passthrough facts for the retry attempt: the upstream text, and the
        // localized headline/step the Runtime diagnosed alongside it.
        summary: receipt.failure?.summary ?? receipt.errorDetail?.slice(0, 1_000) ?? null,
        ...(receipt.failure?.label ? { label: receipt.failure.label } : {}),
        ...(receipt.failure?.step ? { step: receipt.failure.step } : {}),
      } : null,
    ...(serviceRepair ? {
      service: {
        serviceId: serviceRepair.serviceId,
        workspaceId: serviceRepair.workspaceId,
        specificationRevision: serviceRepair.specificationRevision,
        repairOrdinal: serviceRepair.repairOrdinal,
        command: serviceRepair.service.command,
        args: [...serviceRepair.service.args],
        healthUrl: serviceRepair.service.healthUrl,
        state: serviceRepair.service.state,
        exitObserved: serviceRepair.service.exitObserved,
        healthStatus: serviceRepair.service.healthStatus,
        logTail: serviceRepair.service.logTail,
      },
    } : {}),
    knownProgress: serviceRepair ? [...serviceRepair.knownProgress] : runtime?.progress ?? {},
    workspaceDelta: runtime?.workspaceDelta ?? {},
    confirmedCompleted: [] as string[],
    unknownItems: serviceRepair
      ? [...serviceRepair.unknownItems]
      : ['Verify the current workspace and remaining acceptance criteria before making changes.'],
  };
  const serialized = JSON.stringify(packet);
  return serialized.length <= 16_000
    ? packet
    : { ...packet, knownProgress: {}, workspaceDelta: {}, truncated: true };
}

function recoveryChainWorkspaceBaseline(input: {
  sourceRuntime: ExecutorAttemptRuntimeRecord | null;
  workspaceRoot: string;
  findRuntime(attemptId: string): ExecutorAttemptRuntimeRecord | null;
}): WorkspaceState | null {
  const expectedRoot = resolve(input.workspaceRoot);
  const visited = new Set<string>();
  let current = input.sourceRuntime;
  let inherited: WorkspaceState | null = null;
  while (
    current
    && !visited.has(current.attemptId)
    && current.workspaceRoot
    && resolve(current.workspaceRoot) === expectedRoot
  ) {
    visited.add(current.attemptId);
    inherited = parseWorkspaceState(current.workspaceBaseline) ?? inherited;
    current = current.sourceAttemptId
      ? input.findRuntime(current.sourceAttemptId)
      : null;
  }
  return inherited;
}

/**
 * Declared-output change set for a Workspace without a Git baseline. Missing
 * declared outputs stay absent so the completion contract still rejects them.
 */
export function declaredOutputsDelta(root: string, outputs: readonly string[]): WorkspaceDelta {
  const changed: Array<{ path: string; beforeHash: string | null; afterHash: string | null }> = [];
  const seen = new Set<string>();
  for (const output of outputs) {
    const relative = output.replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (!relative || relative.includes('..') || seen.has(relative)) continue;
    seen.add(relative);
    try {
      const absolute = join(root, relative);
      if (!statSync(absolute).isFile()) continue;
      changed.push({ path: relative, beforeHash: null,
        afterHash: createHash('sha256').update(readFileSync(absolute)).digest('hex') });
    } catch {
      // Missing or unreadable outputs remain uncertified by the completion check.
    }
  }
  return { kind: 'git_status_delta_v1' as const, changed, baselineTruncated: false, finalTruncated: false };
}

/**
 * The safe projection identity an edge handoff points at. Absent when the
 * completion persisted no body; the caller then fails the completion instead of
 * landing a `done` Subtask that owes an unmaterializable edge.
 */
function safeProjectionForEdgeHandoffs(
  results: ResultObjectRepo,
  safeProjectionId: string | null | undefined,
  safeBody: string | null,
): { resultId: string; byteLength: number } | null {
  if (!safeProjectionId || safeBody === null) return null;
  const object = results.findObject(safeProjectionId);
  return object
    ? { resultId: object.resultId, byteLength: object.byteLength }
    : null;
}
