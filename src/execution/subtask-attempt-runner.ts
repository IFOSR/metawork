import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import type { ExecutorProgressEvent } from '../executor/adapter.js';
import type { ExecutorAdapter } from '../executor/adapter.js';
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
import type { ExecutionRuntime } from './execution-runtime.js';
import {
  COMPLETION_MARKER_V4,
  validateCompletionProtocol,
  type CompletionAssessment,
  type CompletionContractViolation,
  type CompletionHandoffV3,
} from './completion-protocol.js';
import { SubtaskExecutionContextBuilder } from './subtask-execution-context.js';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';
import { generateInteractionId } from '../utils/id.js';
import { ExecutionEvidenceToolServer } from './execution-evidence-tool-server.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import type { Subtask } from '../core/types.js';
import { ExecutorAttemptRuntimeRepo, type ExecutorAttemptRuntimeRecord } from '../storage/executor-attempt-runtime-repo.js';
import { deriveRecoverySafety } from '../routing/types.js';
import type {
  KernelAttemptKind,
  KernelAttemptPayload,
  KernelRecoveryMode,
} from '../kernel/control-kernel.js';
import {
  captureWorkspaceState,
  deriveWorkspaceDelta,
  type WorkspaceDelta,
  type WorkspaceState,
} from './workspace-change-tracker.js';
import type { WorkspaceStore, WorkspaceHandle, StoredWorkspaceCheckpoint } from './workspace-store.js';
import type { AttemptExecutionBackend } from './attempt-execution-backend.js';
import {
  buildPermissionRules,
  PERMISSION_PROFILE_IDS,
  type PermissionProfileId,
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
  type WorkspacePublicationCompletion,
} from '../storage/workspace-publication-repo.js';
import { AttemptTerminalService } from './attempt-terminal-service.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import { formatExecutorProgress } from '../executor/error-utils.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import {
  ResultObjectRepo,
  type ResultObjectWriter,
} from '../storage/result-object-repo.js';
import type { ScopedExecutionResultReferencePort } from './execution-result-reference-port.js';

export type ProgressCallback = (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;

export interface AuthorizedAttemptIdentity {
  authorizedBinding: AuthorizedExecutorBinding;
  bindingFingerprint: string;
}

export type SubtaskAttemptOutcome =
  | { outcome: 'completed'; attemptId: string; output: string; artifacts: string[]; warnings: string[]; executorName: string; durationMs: number }
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
  permissionRepository: PermissionRepositoryPort;
  kernelWorkflowStore: KernelWorkflowStore;
  workspaceRepository: WorkspaceRepositoryPort;
  sourceRoot: string;
  controlNetwork: string;
  accountId?: string;
  resultRoot: string;
}

/** Owns one Subtask attempt from claim through immutable terminal persistence. */
export class SubtaskAttemptRunner {
  private readonly contextBuilder: SubtaskExecutionContextBuilder;
  private readonly receiptRepo: ExecutorAttemptReceiptRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;
  private readonly attemptRuntimeRepo: ExecutorAttemptRuntimeRepo;
  private readonly managedGitWorkspace: ManagedGitWorkspaceService;
  private readonly dispatchItemRepo: KernelDispatchItemRepo;
  private readonly publicationRepo: WorkspacePublicationRepo;
  private readonly terminalService: AttemptTerminalService;
  private readonly resultObjectRepo: ResultObjectRepo;

  constructor(private readonly deps: SubtaskAttemptRunnerDeps) {
    this.contextBuilder = new SubtaskExecutionContextBuilder(deps.db, {
      accountId: deps.accountId,
      resultRoot: deps.resultRoot,
    });
    this.receiptRepo = new ExecutorAttemptReceiptRepo(deps.db);
    this.handoffRepo = new SubtaskHandoffRepo(deps.db);
    this.attemptRuntimeRepo = new ExecutorAttemptRuntimeRepo(deps.db);
    this.managedGitWorkspace = new ManagedGitWorkspaceService(deps.workspaceStore);
    this.dispatchItemRepo = new KernelDispatchItemRepo(deps.db);
    this.publicationRepo = new WorkspacePublicationRepo(deps.db);
    this.terminalService = new AttemptTerminalService(deps.db);
    this.resultObjectRepo = new ResultObjectRepo(
      deps.db,
      deps.resultRoot,
    );
  }

  private get sessionId(): string {
    return this.deps.getSessionId?.() ?? this.deps.sessionId;
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
    defaultResourceGrant: ResourceClaim[];
    onProgress?: ProgressCallback;
  } & AuthorizedAttemptIdentity): Promise<SubtaskAttemptOutcome> {
    const attemptId = input.attemptId;
    const dispatch = this.requireAuthorizedDispatch(input);
    const agentClassName = dispatch.authorizedBinding.agentClassRef;
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const attemptKind = dispatch.attemptKind;
    const sourceAttemptId = dispatch.sourceAttemptId;
    const expectedStatus = attemptKind === 'primary' ? 'ready' : 'awaiting_decision';
    if (
      !task
      || task.status !== 'running'
      || !subtask
      || subtask.taskId !== input.taskId
      || subtask.status !== expectedStatus
    ) {
      return {
        outcome: 'cancelled_or_stale',
        attemptId,
        reason: `Task or ${expectedStatus} Subtask no longer matches the authorized ${attemptKind} attempt`,
      };
    }
    const sourceReceipt = sourceAttemptId
      ? this.receiptRepo.findByAttemptId(sourceAttemptId)
      : null;
    if (
      sourceAttemptId
      && (
        attemptKind === 'continuation'
        || attemptKind === 'merge_repair'
        || dispatch.recoveryMode === 'native_session'
      )
      && !sameReceiptBinding(sourceReceipt, dispatch)
    ) {
      return {
        outcome: 'cancelled_or_stale',
        attemptId,
        reason: 'continuation binding does not match its source attempt',
      };
    }
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: input.taskId,
      subtask: { id: subtask.id },
      authorizedBinding: dispatch.authorizedBinding,
      attemptId,
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId, agentClassName };

    const leaseToken = `attempt_lease_${randomUUID()}`;
    const resourceClaim = this.deps.resourceLeaseService.claim({
      taskId: input.taskId,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId: claim.workUnit.id,
      claims: input.defaultResourceGrant,
      leaseToken,
    });
    if (resourceClaim.type === 'conflict') {
      claim.release();
      return {
        outcome: 'partition_conflict',
        attemptId,
        claims: input.defaultResourceGrant,
        conflictingLeaseIds: resourceClaim.conflictingLeases.map(lease => lease.id),
      };
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
    let gitWorkspace: ManagedGitWorkspace | null = null;
    let mergeRepair: {
      publicationId: string;
      conflictChainId: string;
      conflictingPaths: string[];
      filePolicy: Record<string, 'text' | 'binary'>;
    } | null = null;
    let capabilityToolServer: CapabilityRequestToolServer | null = null;
    let finalCheckpointReason: 'success' | 'failure' | 'cancelled' = 'failure';
    const heartbeat = setInterval(() => {
      claim.heartbeat();
      this.deps.resourceLeaseService.heartbeat(attemptId, leaseToken);
    }, 20_000);
    try {
      claim.startAttempt();
      if (attemptKind === 'merge_repair') {
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
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
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
      gitWorkspace = await this.managedGitWorkspace.ensure(workspaceIdentity, this.deps.sourceRoot);
      workspace = gitWorkspace;
      if (subtask.dependencies.length > 0) {
        const dependencyCommits = subtask.dependencies.map(dependency => {
          const state = this.deps.workspaceRepository.findByIdentity(
            task.id, subtask.generationId, dependency.fromSubtaskId,
          );
          if (!state?.headCommit) throw new Error(`missing direct dependency workspace_state: ${dependency.fromSubtaskId}`);
          return state.headCommit;
        });
        await this.managedGitWorkspace.applyDependencyStates(gitWorkspace, dependencyCommits);
      }
      if (attemptKind === 'merge_repair') {
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
        }, this.deps.sourceRoot);
        const description = await this.managedGitWorkspace.describeCandidate(
          integrationWorkspace,
          publication.candidateCommit,
        );
        const preparation = await this.managedGitWorkspace.prepareMergeRepair({
          candidateWorkspace: gitWorkspace,
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
        kind: workspace.kind,
        rootUri: pathToFileURL(workspace.rootPath).href,
        baseline: gitWorkspace ? {
          sourceCommit: gitWorkspace.sourceCommit,
          baselineCommit: gitWorkspace.baselineCommit,
          sourceDiffHash: gitWorkspace.sourceDiffHash,
        } : {},
        managedRepositoryUri: gitWorkspace ? pathToFileURL(gitWorkspace.repositoryPath).href : null,
        managedBranch: gitWorkspace?.branch ?? null,
        headCommit: gitWorkspace?.baselineCommit ?? null,
        currentCheckpointId: null,
        status: 'active',
        cleanupAfter: null,
        createdAt: workspaceNow,
        updatedAt: workspaceNow,
      });
      await mkdir(join(workspace.filesPath, '.metaclaw', 'results'), { recursive: true });
      const containerExecutionBackend = this.deps.attemptExecutionBackend.pathMode === 'container'
        || this.deps.attemptExecutionBackend.kind === 'container';
      if (containerExecutionBackend) {
        await this.deps.workspaceStore.prepareForContainerExecution(workspace);
      }
      const inputsPath = join(workspace.rootPath, 'inputs');
      const handoffsPath = join(workspace.rootPath, 'handoffs');
      await Promise.all([mkdir(inputsPath, { recursive: true }), mkdir(handoffsPath, { recursive: true })]);
      const startCheckpoint = await this.deps.workspaceStore.createCheckpoint(workspace, {
        reason: 'attempt_start', attemptId,
      });
      this.deps.workspaceRepository.recordCheckpoint({
        id: startCheckpoint.id,
        workspaceId: workspace.id,
        attemptId,
        reason: 'attempt_start',
        manifestUri: startCheckpoint.manifestUri,
        manifestHash: startCheckpoint.manifestHash,
        manifestSize: startCheckpoint.manifestSize,
        createdAt: startCheckpoint.manifest.createdAt,
        objects: checkpointObjects(startCheckpoint),
      });
      const targetPath = workspace.filesPath;
      workspaceBaseline = captureWorkspaceState(workspace.filesPath);
      const sourceRuntime = sourceAttemptId
        ? this.attemptRuntimeRepo.find(sourceAttemptId)
        : null;
      const recoveryMode: KernelRecoveryMode = dispatch.recoveryMode === 'native_session' && !sourceRuntime?.continuationToken
        ? 'recovery_packet'
        : dispatch.recoveryMode;
      this.attemptRuntimeRepo.start({
        attemptId,
        sourceAttemptId,
        workspaceRoot: workspace.filesPath,
        workspaceBaseline: { ...workspaceBaseline },
        recoverySafety: deriveRecoverySafety(subtask.requiredCapabilities),
        now: startedAt,
      });
      this.attemptRuntimeRepo.appendProgress(attemptId, {
        kind: 'status',
        text: 'Executor 已启动，正在准备受控执行上下文',
      }, startedAt);
      const evidenceToolsAvailable = agentClassName === 'codex-cli' || agentClassName === 'pi-agent';
      const attemptControlHost = this.deps.attemptExecutionBackend.pathMode === 'native'
        ? '127.0.0.1'
        : process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control';
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
          targetPaths: [targetPath],
        },
        evidenceToolsAvailable,
        currentSubtaskOverride: mergeRepair ? {
          title: `Repair merge conflicts for ${subtask.title}`,
          goal: buildMergeRepairGoal(
            subtask.goal,
            mergeRepair.conflictingPaths,
            gitWorkspace.filesPath,
          ),
          deliveryKind: 'edit',
        } : undefined,
        completionContractOverride: mergeRepair ? {
          marker: '---METACLAW-MERGE-REPAIR---',
          protocol: 'metaclaw:merge-repair:v1',
          allowedPaths: mergeRepair.conflictingPaths,
        } : undefined,
        recovery: {
          mode: recoveryMode,
          sourceAttemptId,
          packet: recoveryMode === 'fresh' ? null : boundedRecoveryPacket(sourceReceipt, sourceRuntime),
        },
      });
      evidenceCapability = built.evidenceCapability;
      resultReferenceCapability = built.resultReferenceCapability;
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
        permissionProfileId: requirePermissionProfile(
          dispatch.authorizedBinding.permissionProfileRef,
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
          checkpoint: async reason => {
            if (!workspace) return null;
            const checkpoint = await this.deps.workspaceStore.createCheckpoint(workspace, { reason, attemptId });
            this.deps.workspaceRepository.recordCheckpoint({
              id: checkpoint.id,
              workspaceId: workspace.id,
              attemptId,
              reason,
              manifestUri: checkpoint.manifestUri,
              manifestHash: checkpoint.manifestHash,
              manifestSize: checkpoint.manifestSize,
              createdAt: checkpoint.manifest.createdAt,
              objects: checkpointObjects(checkpoint),
            });
            return checkpoint.id;
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
            sourcePath: this.deps.sourceRoot,
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
            continuationToken: sourceRuntime?.continuationToken ?? null,
            onContinuationToken: token => this.attemptRuntimeRepo.recordContinuationToken(
              attemptId, token, new Date().toISOString(),
            ),
          },
          onRawOutput: chunk => rawResultWriter.append(chunk),
        },
        onProgress: (event, executor) => {
          const safeText = formatExecutorProgress(event.text);
          if (safeText) {
            this.attemptRuntimeRepo.appendProgress(attemptId, {
              kind: event.kind,
              text: safeText,
            }, new Date().toISOString());
          }
          input.onProgress?.(event, executor);
        },
      });
      rawResponse = execution.output;
      if (workspaceBaseline && workspace) {
        workspaceDelta = deriveWorkspaceDelta(
          workspaceBaseline,
          captureWorkspaceState(workspace.filesPath),
        );
        this.attemptRuntimeRepo.recordWorkspaceDelta(
          attemptId,
          workspaceDelta,
          new Date().toISOString(),
        );
      }
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
              workspaceRoot: workspace?.filesPath ?? this.deps.sourceRoot,
              workspaceDelta,
            })
          : null;
        if (
          partialCompletion?.ok
          && partialCompletion.body
          && partialCompletion.assessment.deliverability.status === 'deliverable'
          && partialCompletion.assessment.safety.status === 'safe'
        ) {
          const partialAssessment: CompletionAssessment = {
            ...partialCompletion.assessment,
            result: { kind: 'partial' },
            certification: {
              status: 'uncertified',
              violations: partialCompletion.assessment.certification.violations,
            },
          };
          const resultObjects = this.persistAttemptResults({
            attemptId,
            taskId: task.id,
            generationId: subtask.generationId,
            subtaskId: subtask.id,
            rawResponse,
            body: partialCompletion.body,
            completeness: 'partial',
            rawResultWriter,
          });
          const partialOutcome = this.landContractFailure({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName,
            startedAt,
            rawResponse,
            completionSchemaVersion: 4,
            violations: partialCompletion.assessment.certification.violations,
            errorCode: executionFailure?.code ?? 'executor_partial_result',
            errorDetail: error,
            completionContract: built.context.completionContract,
            terminalState: 'uncertified_result',
            output: this.readResultObject(resultObjects.safeProjectionId, partialCompletion.body),
            assessment: partialAssessment,
            resultObjects,
          });
          claim.markWaiting('partial business result delivered; completion certification pending');
          return partialOutcome;
        }
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: execution.status === 'cancelled' ? 'cancelled_or_stale' : 'executor_failed', rawResponse,
          errorCode: execution.status === 'cancelled' ? 'attempt_cancelled' : 'executor_failed', errorDetail: error,
          failure: executionFailure,
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
          workspace: gitWorkspace,
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

      const outgoingHandoffs = allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const completion = validateCompletionProtocol({
        rawResponse,
        subtask,
        outgoingHandoffs,
        workspaceRoot: built.context.workspaceContext.workingDirectory,
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
      const managedCommit = await this.managedGitWorkspace.commit(
        gitWorkspace,
        `feat: capture ${subtask.id} result`,
      );
      const dispatchItem = this.dispatchItemRepo.find(attemptId);
      const publicationCompletion: WorkspacePublicationCompletion = {
        body: safeBody ?? '',
        artifacts: completion.normalizedArtifacts,
        warnings: completion.warnings,
        handoffs: completedEnvelope.handoffs,
        completionSchemaVersion: 4,
      };
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
          completionSchemaVersion: 4,
          warnings: completion.warnings,
          resultObjects,
        }, completedAt),
        expectedSubtaskStatus: 'running',
        nextSubtaskStatus: 'awaiting_integration',
        subtaskError: null,
        publication: {
          id: `publication_${attemptId}`,
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          sourceAttemptId: attemptId,
          agentClassName,
          candidateCommit: managedCommit.commit,
          completion: publicationCompletion,
          topologyLayer: deriveTopologyLayer(subtask.id, allSubtasks),
          firstDispatchOrder: dispatchItem.batchOrder,
          createdAt: completedAt,
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
          baseline: {
            sourceCommit: gitWorkspace!.sourceCommit,
            baselineCommit: gitWorkspace!.baselineCommit,
            sourceDiffHash: gitWorkspace!.sourceDiffHash,
          },
          managedRepositoryUri: pathToFileURL(gitWorkspace!.repositoryPath).href,
          managedBranch: managedCommit.branch,
          headCommit: managedCommit.commit,
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
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mergeRepair) {
        this.publicationRepo.recordRepairFailure(
          mergeRepair.publicationId,
          message,
          new Date().toISOString(),
        );
      }
      if (!this.receiptRepo.findByAttemptId(attemptId)) {
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse, errorCode: 'attempt_exception', errorDetail: message,
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
      claim.markFailed(message);
      return {
        outcome: 'executor_failed', attemptId, error: message,
        failure: { kind: 'unknown', scope: 'attempt', code: 'attempt_exception', summary: message },
      };
    } finally {
      clearInterval(heartbeat);
      if (workspace) {
        try {
          const checkpoint = await this.deps.workspaceStore.createCheckpoint(workspace, {
            reason: finalCheckpointReason,
            attemptId,
          });
          this.deps.workspaceRepository.recordCheckpoint({
            id: checkpoint.id,
            workspaceId: workspace.id,
            attemptId,
            reason: finalCheckpointReason,
            manifestUri: checkpoint.manifestUri,
            manifestHash: checkpoint.manifestHash,
            manifestSize: checkpoint.manifestSize,
            createdAt: checkpoint.manifest.createdAt,
            objects: checkpointObjects(checkpoint),
          });
        } catch {
          // The terminal receipt remains authoritative; checkpoint recovery is best effort here.
        }
      }
      if (!workspaceDelta && workspaceBaseline && workspace) {
        try {
          this.attemptRuntimeRepo.recordWorkspaceDelta(
            attemptId,
            deriveWorkspaceDelta(workspaceBaseline, captureWorkspaceState(workspace.filesPath)),
            new Date().toISOString(),
          );
        } catch {
          // Failed attempts retain their terminal receipt even when best-effort delta capture fails.
        }
      }
      evidenceCapability?.revoke();
      resultReferenceCapability?.revoke();
      await evidenceToolServer?.close();
      await capabilityToolServer?.close();
      if (this.hasSealedTerminal(attemptId)) {
        this.deps.resourceLeaseService.release(attemptId, leaseToken);
        claim.release();
      }
    }
  }

  async runCorrection(input: {
    attemptId: string;
    sourceAttemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    completionContract: unknown;
    violations: CompletionContractViolation[];
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
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId: input.attemptId, agentClassName };
    const startedAt = new Date().toISOString();
    try {
      claim.startAttempt();
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
      claim.markRunning();
      const sourceResult = this.readCorrectionSourceResult(source);
      const prompt = buildCorrectionPrompt({
        resultId: sourceResult.safe.resultId,
        contentHash: sourceResult.safe.contentHash,
        byteLength: sourceResult.safe.byteLength,
        workspaceChanged: sourceRuntime.workspaceDelta?.changed === true,
        violations: input.violations,
      });
      const result = await this.deps.executionRuntime.runResponseOnly(
        dispatch.authorizedBinding,
        prompt,
        128 * 1024,
      );
      if (!result?.success) {
        const error = result?.error ?? 'AgentClass does not enforce response-only correction';
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: result?.output ?? '', errorCode: 'correction_unavailable', errorDetail: error,
        });
        claim.markFailed(error);
        return {
          outcome: 'executor_failed', attemptId: input.attemptId, error,
          failure: result?.failure ?? { kind: 'unknown', scope: 'attempt', code: 'correction_unavailable', summary: error },
        };
      }
      const activeSubtasks = this.deps.subtaskRepo.listActiveByTask(task.id);
      const allSubtasks = activeSubtasks.length > 0 ? activeSubtasks : this.deps.subtaskRepo.listByTask(task.id);
      const outgoingHandoffs = allSubtasks.flatMap(candidate => {
        const dependency = candidate.dependencies.find(item => item.fromSubtaskId === subtask.id);
        return dependency ? [{ toSubtaskId: candidate.id, requiredItems: dependency.requiredItems }] : [];
      });
      const gitWorkspace = await this.managedGitWorkspace.ensure({
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
      }, this.deps.sourceRoot);
      const correctionMarkerIndex = result.output.indexOf(COMPLETION_MARKER_V4);
      const correctedMetadata = correctionMarkerIndex >= 0
        ? result.output.slice(correctionMarkerIndex)
        : result.output;
      const completion = validateCompletionProtocol({
        rawResponse: `${sourceResult.body}\n\n${correctedMetadata}`,
        subtask,
        outgoingHandoffs,
        workspaceRoot: gitWorkspace.filesPath,
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
          rawResponse: result.output,
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
      const completedEnvelope = completion.envelope;
      const completedAt = new Date().toISOString();
      const managedCommit = await this.managedGitWorkspace.commit(
        gitWorkspace,
        `feat: capture corrected ${subtask.id} result`,
      );
      const dispatchItem = this.dispatchItemRepo.find(input.attemptId);
      if (!dispatchItem) {
        throw new Error(`authorized dispatch item not found: ${input.attemptId}`);
      }
      const landing = this.terminalService.land({
        receipt: buildReceipt({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName, startedAt,
          terminalState: 'completed', rawResponse: result.output, completionSchemaVersion: 4, warnings: completion.warnings,
          resultObjects,
          assessment: completion.assessment,
          completionContract: input.completionContract,
        }, completedAt),
        expectedSubtaskStatus: 'running',
        nextSubtaskStatus: 'awaiting_integration',
        subtaskError: null,
        publication: {
          id: `publication_${input.attemptId}`,
          taskId: task.id,
          generationId: subtask.generationId,
          subtaskId: subtask.id,
          sourceAttemptId: input.attemptId,
          agentClassName,
          candidateCommit: managedCommit.commit,
          completion: {
            body: safeBody ?? '',
            artifacts: completion.normalizedArtifacts,
            warnings: completion.warnings,
            handoffs: completedEnvelope.handoffs,
            completionSchemaVersion: 4,
          },
          topologyLayer: deriveTopologyLayer(subtask.id, allSubtasks),
          firstDispatchOrder: dispatchItem.batchOrder,
          createdAt: completedAt,
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
        return {
          outcome: 'cancelled_or_stale',
          attemptId: input.attemptId,
          reason: 'Cancellation fence won before correction terminal landing',
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
          headCommit: managedCommit.commit,
          status: 'active',
          updatedAt: completedAt,
        });
      }
      return {
        outcome: 'completed', attemptId: input.attemptId, output: safeBody ?? '',
        artifacts: completion.normalizedArtifacts, warnings: completion.warnings,
        executorName: agentClassName, durationMs: result.durationMs,
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

  private isStillCurrent(taskId: string, subtaskId: string, attemptId: string, workUnitId: string): boolean {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    const subtask = this.deps.subtaskRepo.findById(subtaskId);
    return task?.status === 'running'
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
      content: redactSensitiveText(input.body),
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

function requirePermissionProfile(permissionProfileRef: string): PermissionProfileId {
  if (!PERMISSION_PROFILE_IDS.includes(permissionProfileRef as PermissionProfileId)) {
    throw new Error(`authorized permission profile is not supported: ${permissionProfileRef}`);
  }
  return permissionProfileRef as PermissionProfileId;
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
    'Finish with Markdown followed by exactly one ---METACLAW-MERGE-REPAIR--- trailer.',
    'The trailer JSON must be {"protocol":"metaclaw:merge-repair:v1","resolvedPaths":["..."],"verification":{"summary":"..."}}.',
  ].join('\n');
}

function parseMergeRepairReport(rawResponse: string): {
  resolvedPaths: string[];
  verificationSummary: string;
} {
  const marker = '---METACLAW-MERGE-REPAIR---';
  const markerIndex = rawResponse.lastIndexOf(marker);
  if (markerIndex < 0 || rawResponse.indexOf(marker) !== markerIndex) {
    throw new Error('merge repair response must contain exactly one protocol trailer');
  }
  const payloadText = rawResponse.slice(markerIndex + marker.length).trim();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('merge repair trailer is not valid JSON');
  }
  if (!payload || typeof payload !== 'object') throw new Error('merge repair trailer must be an object');
  const record = payload as Record<string, unknown>;
  if (record.protocol !== 'metaclaw:merge-repair:v1') {
    throw new Error('merge repair trailer protocol is invalid');
  }
  if (!Array.isArray(record.resolvedPaths)
    || record.resolvedPaths.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new Error('merge repair trailer resolvedPaths must contain non-empty strings');
  }
  const verification = record.verification;
  if (!verification || typeof verification !== 'object') {
    throw new Error('merge repair trailer verification is required');
  }
  const summary = (verification as Record<string, unknown>).summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('merge repair verification.summary must be non-empty');
  }
  return {
    resolvedPaths: record.resolvedPaths as string[],
    verificationSummary: summary.trim(),
  };
}

function checkpointObjects(checkpoint: StoredWorkspaceCheckpoint) {
  return checkpoint.manifest.entries.flatMap(entry => (
    entry.type === 'file' && entry.hash && entry.objectUri
      ? [{ hash: entry.hash, uri: entry.objectUri, size: entry.size, mediaType: null }]
      : []
  ));
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
  violations: CompletionContractViolation[];
}): string {
  const guidance = [...new Set(input.violations.map(violation => correctionGuidance(violation.code)))];
  return [
    'Repair only completion metadata. Do not execute the task, use tools, inspect files, change the workspace, or rewrite the business result.',
    'The immutable business result is not included in this prompt. Return exactly one completion trailer and no business body.',
    `Immutable result reference: ${input.resultId}`,
    `Immutable result hash: ${input.contentHash}`,
    `Immutable result bytes: ${input.byteLength}`,
    `Workspace changed: ${String(input.workspaceChanged)}`,
    `Trailer marker: ${COMPLETION_MARKER_V4}`,
    'Successful report schema: {"evidence":["<evidence>"],"noChangeReason":null}',
    'Failure report schema: {"failure":{"kind":"task_failed","code":"<stable_code>","summary":"<concise explanation>"}}',
    'Do not return schema/status identity, Task/Subtask/attempt/WorkUnit IDs, acceptance keys, or handoff identities. Runtime owns and injects them.',
    `Validation guidance:\n${guidance.map(item => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

function correctionGuidance(code: CompletionContractViolation['code']): string {
  switch (code) {
    case 'completion_artifact_invalid':
      return 'Do not declare artifact paths; Runtime derives changed files from the authoritative workspace delta.';
    case 'completion_no_change_reason_mismatch':
      return 'Use null when files changed or for report delivery; for a zero-change edit provide a concise non-empty reason.';
    case 'completion_report_workspace_changed':
      return 'The report changed the workspace and cannot be corrected by response formatting; return a structured failure.';
    case 'completion_workspace_delta_uncertain':
      return 'The workspace delta is not authoritative and cannot be repaired in the response; return a structured failure.';
    case 'completion_budget_exceeded':
      return 'Return valid metadata without changing or shortening the original business result.';
    default:
      return 'Return exactly one strict identity-free report matching one of the schemas above.';
  }
}

function boundedRecoveryPacket(
  receipt: ExecutorAttemptReceipt | null,
  runtime: ExecutorAttemptRuntimeRecord | null,
): Record<string, unknown> {
  const packet = {
    sourceAttemptId: receipt?.attemptId ?? runtime?.attemptId ?? null,
    failure: receipt ? {
      terminalState: receipt.terminalState,
      code: receipt.failure?.code ?? receipt.errorCode,
      summary: receipt.failure?.summary ?? receipt.errorDetail?.slice(0, 1_000) ?? null,
    } : null,
    knownProgress: runtime?.progress ?? {},
    workspaceDelta: runtime?.workspaceDelta ?? {},
    confirmedCompleted: [] as string[],
    unknownItems: ['Verify the current workspace and remaining acceptance criteria before making changes.'],
  };
  const serialized = JSON.stringify(packet);
  return serialized.length <= 16_000
    ? packet
    : { ...packet, knownProgress: {}, workspaceDelta: {}, truncated: true };
}
