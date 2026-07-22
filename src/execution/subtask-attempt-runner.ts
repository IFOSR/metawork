import { resolve, join } from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
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
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { ExecutionMode } from './types.js';
import type { ExecutionRuntime } from './execution-runtime.js';
import {
  COMPLETION_MARKER_V2,
  validateCompletionProtocol,
  type CompletionContractViolation,
  type CompletionHandoffV2,
} from './completion-protocol.js';
import { SubtaskExecutionContextBuilder } from './subtask-execution-context.js';
import type { WorkUnitClaimService } from './work-unit-claim-service.js';
import { generateInteractionId } from '../utils/id.js';
import { ExecutionEvidenceToolServer } from './execution-evidence-tool-server.js';
import type { KernelFailure } from '../core/kernel-failure.js';
import { ExecutorAttemptRuntimeRepo, type ExecutorAttemptRuntimeRecord } from '../storage/executor-attempt-runtime-repo.js';
import { deriveRecoverySafety } from '../executor/builtin-executor-catalog.js';
import type { KernelAttemptKind, KernelRecoveryMode } from '../kernel/control-kernel.js';
import { captureWorkspaceState, deriveWorkspaceDelta, type WorkspaceState } from './workspace-change-tracker.js';
import type { WorkspaceStore, WorkspaceHandle, StoredWorkspaceCheckpoint } from './workspace-store.js';
import type { AttemptSandboxPort } from './attempt-sandbox.js';
import type { ResourceClaim } from '../resource/index.js';
import type { ResourceLeaseService } from './resource-lease-service.js';
import { RegisteredCapabilityResourceResolver } from './capability-resource-resolver.js';
import { PermissionWorkflowService } from './permission-workflow-service.js';
import { CapabilityRequestToolServer } from './capability-request-tool-server.js';
import type { PermissionRepositoryPort } from '../resource/index.js';
import type { KernelWorkflowStore } from '../kernel/kernel-workflow.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import { ManagedGitWorkspaceService, type ManagedGitWorkspace } from './managed-git-workspace.js';

export type ProgressCallback = (event: ExecutorProgressEvent, executor: ExecutorAdapter) => void;

export type SubtaskAttemptOutcome =
  | { outcome: 'completed'; attemptId: string; output: string; artifacts: string[]; warnings: string[]; executorName: string; durationMs: number }
  | { outcome: 'capacity_unavailable'; attemptId: string; agentClassName: string }
  | { outcome: 'contract_failed'; attemptId: string; workUnitId: string; agentClassName: string; responseBytes: number; receiptCount: number; completionContract: unknown; violations: CompletionContractViolation[] }
  | { outcome: 'executor_failed'; attemptId: string; error: string; failure: KernelFailure }
  | { outcome: 'partition_conflict'; attemptId: string; claims: ResourceClaim[]; conflictingLeaseIds: string[] }
  | { outcome: 'cancelled_or_stale'; attemptId: string; reason: string };

export interface SubtaskAttemptRunnerDeps {
  db: Database.Database;
  sessionId: string;
  taskRuntimeService: TaskRuntimeService;
  subtaskRepo: SubtaskRepo;
  workUnitClaimService: Pick<WorkUnitClaimService, 'claim' | 'isClaimCurrent'>;
  executionRuntime: ExecutionRuntime;
  agentClassService: AgentClassService;
  workspaceStore: WorkspaceStore;
  attemptSandbox: AttemptSandboxPort;
  resourceLeaseService: ResourceLeaseService;
  permissionRepository: PermissionRepositoryPort;
  kernelWorkflowStore: KernelWorkflowStore;
  workspaceRepository: WorkspaceRepositoryPort;
  sourceRoot: string;
  seedSource?: boolean;
  controlNetwork: string;
}

/** Owns one Subtask attempt from claim through immutable terminal persistence. */
export class SubtaskAttemptRunner {
  private readonly contextBuilder: SubtaskExecutionContextBuilder;
  private readonly receiptRepo: ExecutorAttemptReceiptRepo;
  private readonly handoffRepo: SubtaskHandoffRepo;
  private readonly attemptRuntimeRepo: ExecutorAttemptRuntimeRepo;
  private readonly managedGitWorkspace: ManagedGitWorkspaceService;

  constructor(private readonly deps: SubtaskAttemptRunnerDeps) {
    this.contextBuilder = new SubtaskExecutionContextBuilder(deps.db);
    this.receiptRepo = new ExecutorAttemptReceiptRepo(deps.db);
    this.handoffRepo = new SubtaskHandoffRepo(deps.db);
    this.attemptRuntimeRepo = new ExecutorAttemptRuntimeRepo(deps.db);
    this.managedGitWorkspace = new ManagedGitWorkspaceService(deps.workspaceStore);
  }

  supportsResponseOnly(agentClassName: string): boolean {
    return this.deps.executionRuntime.supportsResponseOnly(agentClassName);
  }

  supportsContinuation(agentClassName: string): boolean {
    return this.deps.executionRuntime.supportsContinuation(agentClassName);
  }

  landHeartbeatLost(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    workUnitId: string;
    agentClassName: string;
  }): void {
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    if (!subtask || subtask.status === 'done' || this.receiptRepo.findByAttemptId(input.attemptId)) return;
    const now = new Date().toISOString();
    this.deps.db.transaction(() => {
      this.receiptRepo.insert(buildReceipt({
        ...input,
        startedAt: now,
        terminalState: 'heartbeat_lost',
        rawResponse: '',
        errorCode: 'heartbeat_lost',
        errorDetail: 'WorkUnit lease expired before a terminal observation',
        failure: {
          kind: 'heartbeat_lost', scope: 'agent_class', code: 'heartbeat_lost',
          summary: 'WorkUnit lease expired before a terminal observation',
        },
      }, now));
      this.deps.subtaskRepo.updateStatus(input.subtaskId, 'awaiting_decision', {
        error: 'WorkUnit heartbeat lost',
      });
    })();
  }

  async run(input: {
    attemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    agentClassName: string;
    executionMode: ExecutionMode;
    attemptKind?: KernelAttemptKind;
    sourceAttemptId?: string | null;
    recoveryMode?: KernelRecoveryMode;
    defaultResourceGrant: ResourceClaim[];
    onProgress?: ProgressCallback;
  }): Promise<SubtaskAttemptOutcome> {
    const attemptId = input.attemptId;
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const attemptKind = input.attemptKind ?? 'primary';
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
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: input.taskId,
      subtask: { id: subtask.id, preferredAgentClassList: [input.agentClassName] },
      attemptId,
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId, agentClassName: input.agentClassName };

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
    let evidenceCapability: { revoke(): void } | null = null;
    let evidenceToolServer: ExecutionEvidenceToolServer | null = null;
    let workspaceBaseline: WorkspaceState | null = null;
    let workspace: WorkspaceHandle | null = null;
    let gitWorkspace: ManagedGitWorkspace | null = null;
    let capabilityToolServer: CapabilityRequestToolServer | null = null;
    let finalCheckpointReason: 'success' | 'failure' | 'cancelled' = 'failure';
    const heartbeat = setInterval(() => {
      claim.heartbeat();
      this.deps.resourceLeaseService.heartbeat(attemptId, leaseToken);
    }, 20_000);
    try {
      claim.startAttempt();
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
      claim.markRunning();
      const agentClass = this.deps.agentClassService.listAgentClasses().find(item => item.name === input.agentClassName);
      if (!agentClass || claim.workUnit.agentClassName !== input.agentClassName) {
        throw new Error(`attempt AgentClass mismatch: ${input.agentClassName}`);
      }
      const activeSubtasks = this.deps.subtaskRepo.listActiveByTask(input.taskId);
      const allSubtasks = activeSubtasks.length > 0 ? activeSubtasks : this.deps.subtaskRepo.listByTask(input.taskId);
      const workspaceIdentity = {
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
      };
      gitWorkspace = await this.managedGitWorkspace.ensure(workspaceIdentity, this.deps.sourceRoot);
      workspace = gitWorkspace ?? await this.deps.workspaceStore.ensureWorkspace(workspaceIdentity, 'directory');
      if (gitWorkspace && subtask.dependencies.length > 0) {
        const dependencyCommits = subtask.dependencies.map(dependency => {
          const state = this.deps.workspaceRepository.findByIdentity(
            task.id, subtask.generationId, dependency.fromSubtaskId,
          );
          if (!state?.headCommit) throw new Error(`missing direct dependency workspace_state: ${dependency.fromSubtaskId}`);
          return state.headCommit;
        });
        await this.managedGitWorkspace.applyDependencyStates(gitWorkspace, dependencyCommits);
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
      if (!gitWorkspace && this.deps.seedSource !== false && (await readdir(workspace.filesPath)).length === 0) {
        await this.deps.workspaceStore.seedDirectory(workspace, this.deps.sourceRoot);
      }
      await mkdir(join(workspace.filesPath, '.metaclaw', 'results'), { recursive: true });
      await this.deps.workspaceStore.prepareForSandbox(workspace);
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
      const sourceRuntime = input.sourceAttemptId
        ? this.attemptRuntimeRepo.find(input.sourceAttemptId)
        : null;
      const sourceReceipt = input.sourceAttemptId
        ? this.receiptRepo.findByAttemptId(input.sourceAttemptId)
        : null;
      const recoveryMode: KernelRecoveryMode = input.recoveryMode === 'native_session' && !sourceRuntime?.continuationToken
        ? 'recovery_packet'
        : input.recoveryMode ?? 'fresh';
      this.attemptRuntimeRepo.start({
        attemptId,
        sourceAttemptId: input.sourceAttemptId ?? null,
        workspaceRoot: workspace.filesPath,
        workspaceBaseline: { ...workspaceBaseline },
        recoverySafety: deriveRecoverySafety(subtask.requiredCapabilities),
        now: startedAt,
      });
      const evidenceToolsAvailable = input.agentClassName === 'codex-cli' || input.agentClassName === 'pi-agent';
      const built = this.contextBuilder.build({
        executionId: input.executionId,
        task,
        subtask,
        allSubtasks,
        attemptId,
        workUnitId: claim.workUnit.id,
        sessionId: this.deps.sessionId,
        workspaceContext: {
          allowFilesystem: true,
          workingDirectory: workspace.filesPath,
          targetPaths: [targetPath],
        },
        evidenceToolsAvailable,
        recovery: {
          mode: recoveryMode,
          sourceAttemptId: input.sourceAttemptId ?? null,
          packet: recoveryMode === 'fresh' ? null : boundedRecoveryPacket(sourceReceipt, sourceRuntime),
        },
      });
      evidenceCapability = built.evidenceCapability;
      if (evidenceToolsAvailable) {
        evidenceToolServer = new ExecutionEvidenceToolServer(built.evidenceCapability, {
          advertisedHost: process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control',
        });
        built.context.evidenceTools.binding = await evidenceToolServer.start();
      }
      const capabilityContext = {
        sessionId: this.deps.sessionId,
        taskId: task.id,
        generationId: subtask.generationId,
        subtaskId: subtask.id,
        attemptId,
        agentClassName: agentClass.name,
        permissionProfileId: agentClass.permissionProfileId ?? 'restricted-custom' as const,
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
        sandbox: this.deps.attemptSandbox,
        workflowStore: this.deps.kernelWorkflowStore,
        rules: [],
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
            if (capabilityContext.containerId) await this.deps.attemptSandbox.stop(capabilityContext.containerId);
          },
          onRecoveryAuthorized: async () => undefined,
        },
      });
      capabilityToolServer = new CapabilityRequestToolServer(permissionWorkflow, {
        advertisedHost: process.env.METACLAW_CONTROL_HOST ?? 'metaclaw-control',
      });
      const capabilityBinding = await capabilityToolServer.start();
      const execution = await this.deps.executionRuntime.run({
        taskId: input.taskId,
        executionId: input.executionId,
        spec: { subtask, workUnit: claim.workUnit, agentClass, acceptance: subtask.acceptance, expectedOutput: subtask.expectedOutput },
        executorInput: {
          context: built.context,
          sandbox: {
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
            onContainerCreated: containerId => { capabilityContext.containerId = containerId; },
          },
          recovery: {
            mode: recoveryMode,
            continuationToken: sourceRuntime?.continuationToken ?? null,
            onContinuationToken: token => this.attemptRuntimeRepo.recordContinuationToken(
              attemptId, token, new Date().toISOString(),
            ),
          },
        },
        onProgress: (event, executor) => {
          this.attemptRuntimeRepo.recordProgress(attemptId, {
            kind: event.kind,
            text: event.text.slice(0, 2_000),
          }, new Date().toISOString());
          input.onProgress?.(event, executor);
        },
      });
      rawResponse = execution.output;
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
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: agentClass.name, startedAt,
          terminalState: execution.status === 'cancelled' ? 'cancelled_or_stale' : 'executor_failed', rawResponse,
          errorCode: execution.status === 'cancelled' ? 'attempt_cancelled' : 'executor_failed', errorDetail: error,
          failure: executionFailure,
        });
        claim.markFailed(error);
        return execution.status === 'cancelled'
          ? { outcome: 'cancelled_or_stale', attemptId, reason: error }
          : {
              outcome: 'executor_failed', attemptId, error,
              failure: executionFailure ?? { kind: 'unknown', scope: 'attempt', code: 'executor_failed', summary: error },
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
        targetPaths: built.context.workspaceContext.targetPaths,
        cwd: built.context.workspaceContext.workingDirectory,
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        const transaction = this.deps.db.transaction(() => {
          this.receiptRepo.insert(buildReceipt({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName: agentClass.name,
            startedAt,
            terminalState: 'contract_blocked',
            rawResponse,
            completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
            violations: completion.violations,
            errorCode: completion.violations[0]?.code ?? 'completion_malformed',
            errorDetail: detail,
          }));
          this.deps.subtaskRepo.updateStatus(subtask.id, 'awaiting_decision', { error: detail });
        });
        transaction();
        claim.markFailed(detail);
        return {
          outcome: 'contract_failed', attemptId, workUnitId: claim.workUnit.id, agentClassName: agentClass.name,
          responseBytes: Buffer.byteLength(rawResponse, 'utf8'),
          receiptCount: this.receiptRepo.countByTerminal(task.id, subtask.id, 'contract_blocked'),
          completionContract: built.context.completionContract,
          violations: completion.violations,
        };
      }
      if (completion.envelope.status === 'failed') {
        const failure = completion.envelope.failure;
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: agentClass.name, startedAt,
          terminalState: 'executor_failed', rawResponse, completionSchemaVersion: 2,
          errorCode: failure.code, errorDetail: failure.summary,
          failure: { ...failure, scope: 'task' },
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
        this.deps.db.transaction(() => {
          this.receiptRepo.insert(buildReceipt({
            attemptId,
            executionId: input.executionId,
            taskId: task.id,
            subtaskId: subtask.id,
            workUnitId: claim.workUnit.id,
            agentClassName: agentClass.name,
            startedAt,
            terminalState: 'cancelled_or_stale',
            rawResponse,
            errorCode: 'attempt_stale',
            errorDetail: detail,
          }));
          if (this.deps.subtaskRepo.findById(subtask.id)?.status === 'running') {
            this.deps.subtaskRepo.updateStatus(subtask.id, 'awaiting_decision', { error: detail });
          }
        })();
        if (this.isAttemptClaimCurrent(attemptId, claim.workUnit.id)) {
          claim.markFailed(detail);
        }
        return { outcome: 'cancelled_or_stale', attemptId, reason: 'attempt became stale before commit' };
      }

      const completedAt = new Date().toISOString();
      const managedCommit = gitWorkspace
        ? await this.managedGitWorkspace.commit(
            gitWorkspace,
            `feat: capture ${subtask.id} result`,
          )
        : null;
      this.deps.db.transaction(() => {
        this.receiptRepo.insert(buildReceipt({
          attemptId,
          executionId: input.executionId,
          taskId: task.id,
          subtaskId: subtask.id,
          workUnitId: claim.workUnit.id,
          agentClassName: agentClass.name,
          startedAt,
          terminalState: 'completed',
          rawResponse,
          completionSchemaVersion: 2,
          warnings: completion.warnings,
        }, completedAt));
        for (const handoff of completedEnvelope.handoffs) {
          this.handoffRepo.insert({
            taskId: task.id,
            fromSubtaskId: subtask.id,
            toSubtaskId: handoff.toSubtaskId,
            attemptId,
            items: handoff.items,
            completionSchemaVersion: 2,
            createdAt: completedAt,
          });
        }
        this.deps.subtaskRepo.updateStatus(subtask.id, 'done', {
          result: completion.body,
          artifacts: completion.normalizedArtifacts,
          verification: { warnings: completion.warnings, completionSchemaVersion: 2 },
          error: null,
        });
      })();
      if (managedCommit && workspace) {
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
          status: 'done',
          cleanupAfter: null,
          createdAt: completedAt,
          updatedAt: completedAt,
        });
      }
      finalCheckpointReason = 'success';
      return {
        outcome: 'completed',
        attemptId,
        output: completion.body,
        artifacts: completion.normalizedArtifacts,
        warnings: completion.warnings,
        executorName: execution.executorName,
        durationMs: execution.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.persistNonSuccess({
          attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse, errorCode: 'attempt_exception', errorDetail: message,
        });
      } catch {
        // Preserve the original attempt exception; the finally block still clears the claim.
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
      if (workspaceBaseline && workspace) {
        this.attemptRuntimeRepo.recordWorkspaceDelta(
          attemptId,
          deriveWorkspaceDelta(workspaceBaseline, captureWorkspaceState(workspace.filesPath)),
          new Date().toISOString(),
        );
      }
      evidenceCapability?.revoke();
      await evidenceToolServer?.close();
      await capabilityToolServer?.close();
      this.deps.resourceLeaseService.release(attemptId, leaseToken);
      claim.release();
    }
  }

  async runCorrection(input: {
    attemptId: string;
    sourceAttemptId: string;
    executionId: string;
    taskId: string;
    subtaskId: string;
    agentClassName: string;
    completionContract: unknown;
    violations: CompletionContractViolation[];
  }): Promise<SubtaskAttemptOutcome> {
    const task = this.deps.taskRuntimeService.findTask(input.taskId);
    const subtask = this.deps.subtaskRepo.findById(input.subtaskId);
    const source = this.receiptRepo.findByAttemptId(input.sourceAttemptId);
    if (!task || !subtask || subtask.status !== 'awaiting_decision' || !source || source.agentClassName !== input.agentClassName) {
      return { outcome: 'cancelled_or_stale', attemptId: input.attemptId, reason: 'response-only correction source is stale' };
    }
    const claim = await this.deps.workUnitClaimService.claim({
      taskId: task.id,
      subtask: { id: subtask.id, preferredAgentClassList: [input.agentClassName] },
      attemptId: input.attemptId,
    });
    if (!claim) return { outcome: 'capacity_unavailable', attemptId: input.attemptId, agentClassName: input.agentClassName };
    const startedAt = new Date().toISOString();
    try {
      claim.startAttempt();
      this.deps.subtaskRepo.updateStatus(subtask.id, 'running');
      claim.markRunning();
      const prompt = buildCorrectionPrompt(source.rawResponse, input.completionContract, input.violations);
      const result = await this.deps.executionRuntime.runResponseOnly(input.agentClassName, prompt, 128 * 1024);
      if (!result?.success) {
        const error = result?.error ?? 'AgentClass does not enforce response-only correction';
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
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
      const targetPath = resolve(process.cwd(), 'metaclaw-tasks', task.id);
      const completion = validateCompletionProtocol({
        rawResponse: result.output,
        subtask,
        outgoingHandoffs,
        targetPaths: [targetPath],
        cwd: process.cwd(),
        incomingUsageByTarget: new Map(outgoingHandoffs.map(contract => [
          contract.toSubtaskId,
          summarizeHandoffUsage(this.handoffRepo.listIncoming(task.id, contract.toSubtaskId)),
        ])),
      });
      if (!completion.ok) {
        const detail = completion.violations.map(item => `${item.code}:${item.path}:${item.message}`).join('; ');
        this.deps.db.transaction(() => {
          this.receiptRepo.insert(buildReceipt({
            attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
            workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
            terminalState: 'contract_blocked', rawResponse: result.output,
            completionSchemaVersion: completion.envelope?.schemaVersion ?? null,
            violations: completion.violations, errorCode: completion.violations[0]?.code ?? 'completion_malformed', errorDetail: detail,
          }));
          this.deps.subtaskRepo.updateStatus(subtask.id, 'awaiting_decision', { error: detail });
        })();
        claim.markFailed(detail);
        return {
          outcome: 'contract_failed', attemptId: input.attemptId, workUnitId: claim.workUnit.id,
          agentClassName: input.agentClassName, responseBytes: Buffer.byteLength(result.output, 'utf8'),
          receiptCount: this.receiptRepo.countByTerminal(task.id, subtask.id, 'contract_blocked'),
          completionContract: input.completionContract, violations: completion.violations,
        };
      }
      if (completion.envelope.status === 'failed') {
        const failure = completion.envelope.failure;
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: result.output, completionSchemaVersion: 2,
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
      this.deps.db.transaction(() => {
        this.receiptRepo.insert(buildReceipt({
          attemptId: input.attemptId, executionId: input.executionId, taskId: task.id, subtaskId: subtask.id,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'completed', rawResponse: result.output, completionSchemaVersion: 2, warnings: completion.warnings,
        }, completedAt));
        for (const handoff of completedEnvelope.handoffs) {
          this.handoffRepo.insert({
            taskId: task.id, fromSubtaskId: subtask.id, toSubtaskId: handoff.toSubtaskId,
            attemptId: input.attemptId, items: handoff.items, completionSchemaVersion: 2, createdAt: completedAt,
          });
        }
        this.deps.subtaskRepo.updateStatus(subtask.id, 'done', {
          result: completion.body, artifacts: completion.normalizedArtifacts,
          verification: { warnings: completion.warnings, completionSchemaVersion: 2 }, error: null,
        });
      })();
      return {
        outcome: 'completed', attemptId: input.attemptId, output: completion.body,
        artifacts: completion.normalizedArtifacts, warnings: completion.warnings,
        executorName: input.agentClassName, durationMs: result.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.receiptRepo.findByAttemptId(input.attemptId)) {
        this.persistNonSuccess({
          attemptId: input.attemptId, executionId: input.executionId, taskId: input.taskId, subtaskId: input.subtaskId,
          workUnitId: claim.workUnit.id, agentClassName: input.agentClassName, startedAt,
          terminalState: 'executor_failed', rawResponse: '', errorCode: 'correction_exception', errorDetail: message,
        });
      }
      claim.markFailed(message);
      return {
        outcome: 'executor_failed', attemptId: input.attemptId, error: message,
        failure: { kind: 'unknown', scope: 'attempt', code: 'correction_exception', summary: message },
      };
    } finally {
      claim.release();
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
  }): void {
    this.deps.db.transaction(() => {
      this.receiptRepo.insert(buildReceipt(input));
      this.deps.subtaskRepo.updateStatus(input.subtaskId, 'awaiting_decision', { error: input.errorDetail });
    })();
  }
}

function summarizeHandoffUsage(handoffs: Array<{ items: CompletionHandoffV2['items'] }>): {
  textCharacters: number;
  artifactPaths: number;
} {
  let textCharacters = 0;
  let artifactPaths = 0;
  for (const handoff of handoffs) {
    for (const item of handoff.items) {
      if (item.type === 'text') textCharacters += item.value.length;
      else artifactPaths += item.paths.length;
    }
  }
  return { textCharacters, artifactPaths };
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
    rawResponse: input.rawResponse,
    completionSchemaVersion: input.completionSchemaVersion ?? null,
    parsing: { completionMarker: input.completionSchemaVersion ? 'parsed' : 'unavailable' },
    verification: { warnings: input.warnings ?? [], violations: input.violations ?? [] },
    errorCode: input.errorCode ?? null,
    errorDetail: input.errorDetail ?? null,
    failure: input.failure ?? null,
  };
}

function buildCorrectionPrompt(
  rawResponse: string,
  completionContract: unknown,
  violations: CompletionContractViolation[],
): string {
  return [
    'Correct only the final response format. Do not execute the task, use tools, inspect files, or change the workspace.',
    'Return non-empty Markdown followed by exactly one completion trailer.',
    `Trailer marker: ${COMPLETION_MARKER_V2}`,
    `Completion contract:\n${JSON.stringify(completionContract, null, 2)}`,
    `Violations:\n${JSON.stringify(violations, null, 2)}`,
    `Original response:\n${rawResponse}`,
  ].join('\n\n');
}

function boundedRecoveryPacket(
  receipt: ExecutorAttemptReceipt | null,
  runtime: ExecutorAttemptRuntimeRecord | null,
): Record<string, unknown> {
  const packet = {
    sourceAttemptId: receipt?.attemptId ?? runtime?.attemptId ?? null,
    failure: receipt ? {
      terminalState: receipt.terminalState,
      code: receipt.errorCode,
      summary: receipt.errorDetail?.slice(0, 1_000) ?? null,
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
