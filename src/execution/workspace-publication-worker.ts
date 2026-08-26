import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { KernelEvent } from '../kernel/control-kernel.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import { SubtaskHandoffRepo } from '../storage/subtask-handoff-repo.js';
import type { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import type { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import {
  WorkspacePublicationRepo,
  type WorkspacePublicationRecord,
} from '../storage/workspace-publication-repo.js';
import type { WorkspaceRepositoryPort } from './repositories.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { ResourceLeaseService } from './resource-lease-service.js';
import { ManagedGitWorkspaceService } from './managed-git-workspace.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import { ResultObjectRepo } from '../storage/result-object-repo.js';
import type { PersistedSubtaskHandoffItem } from '../storage/subtask-handoff-repo.js';
import type {
  UserArtifactPublicationService,
} from '../delivery/user-artifact-publication-service.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import { mergeConflictObservationId } from './merge-repair-protocol.js';

export interface IntegratedWorkspacePublication {
  type: 'integrated';
  publicationId: string;
  taskId: string;
  subtaskId: string;
  sourceAttemptId: string;
  agentClassName: string;
  integrationCommit: string;
  resultId: string | null;
  output: string;
  warnings: string[];
  /** 已复制到用户 Workspace 的可见 artifact（仅 projection，无内部路径）。 */
  userArtifacts: ArtifactProjection[];
}

export interface ConflictedWorkspacePublication {
  type: 'conflicted';
  event: Extract<KernelEvent, { type: 'merge_conflict_observed' }>;
}

export interface CancelledWorkspacePublication {
  type: 'cancelled';
  publicationId: string;
  taskId: string;
  subtaskId: string;
  observedIntegrationCommit: string | null;
}

export type WorkspacePublicationOutcome =
  | IntegratedWorkspacePublication
  | ConflictedWorkspacePublication
  | CancelledWorkspacePublication;

export interface WorkspacePublicationWorkerDeps {
  db: Database.Database;
  sessionId: string;
  getSessionId?(): string;
  accountId?: string;
  resultRoot: string;
  sourceRoot: string;
  workspaceStore: WorkspaceStore;
  workspaceRepository: WorkspaceRepositoryPort;
  subtaskRepo: SubtaskRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  resourceLeaseService: ResourceLeaseService;
  dispatchItemRepo: KernelDispatchItemRepo;
  taskRuntimeService: TaskRuntimeService;
  /** 用户产物发布服务；提供后集成成功的 artifact 会复制到用户 Workspace。 */
  userArtifactPublication?: UserArtifactPublicationService;
  /** 根据当前 Conversation session 解析用户可见 Workspace。 */
  resolveUserWorkspaceRoot?: (
    sessionId: string,
  ) => Promise<string | null> | string | null;
}

/**
 * Serializes candidate publication for one Task generation.
 * Git work happens before the SQLite projection; interrupted applying rows are
 * replayed idempotently because merging an ancestor candidate is a no-op.
 */
export class WorkspacePublicationWorker {
  private readonly publications: WorkspacePublicationRepo;
  private readonly handoffs: SubtaskHandoffRepo;
  private readonly git: ManagedGitWorkspaceService;
  private readonly results: ResultObjectRepo;
  private readonly reconciledGenerations = new Set<string>();
  private readonly activeDrains = new Map<string, Promise<WorkspacePublicationOutcome[]>>();

  constructor(private readonly deps: WorkspacePublicationWorkerDeps) {
    this.publications = new WorkspacePublicationRepo(deps.db);
    this.handoffs = new SubtaskHandoffRepo(deps.db);
    this.git = new ManagedGitWorkspaceService(deps.workspaceStore);
    this.results = new ResultObjectRepo(
      deps.db,
      deps.resultRoot,
    );
  }

  private get sessionId(): string {
    return this.deps.getSessionId?.() ?? this.deps.sessionId;
  }

  async drain(taskId: string, generationId: string): Promise<WorkspacePublicationOutcome[]> {
    const key = `${taskId}\u0000${generationId}`;
    const active = this.activeDrains.get(key);
    if (active) return active;
    const drain = this.drainSerial(taskId, generationId, key)
      .finally(() => this.activeDrains.delete(key));
    this.activeDrains.set(key, drain);
    return drain;
  }

  private async drainSerial(
    taskId: string,
    generationId: string,
    key: string,
  ): Promise<WorkspacePublicationOutcome[]> {
    const outcomes: WorkspacePublicationOutcome[] = [];
    if (!this.reconciledGenerations.has(key)) {
      this.reconciledGenerations.add(key);
      this.publications.recoverApplying(taskId, generationId, new Date().toISOString());
    }
    await this.reconcileIntegratedArtifacts(taskId, generationId);
    while (true) {
      const publication = this.publications.findNextBlocking(taskId, generationId);
      if (!publication) break;
      if (publication.status === 'conflicted' || publication.status === 'parked') {
        if (await this.requeueStaleBaselineConflict(publication)) continue;
        if (publication.status === 'parked') break;
        const replay = this.replayConflict(publication);
        if (replay) outcomes.push(replay);
        break;
      }
      if (publication.status !== 'pending') break;
      if (!this.isStablePredecessorReleased(publication)) break;
      const outcome = await this.publish(publication);
      if (!outcome) break;
      outcomes.push(outcome);
      if (outcome.type === 'conflicted') break;
    }
    return outcomes;
  }

  private async requeueStaleBaselineConflict(
    publication: WorkspacePublicationRecord,
  ): Promise<boolean> {
    const latestMerge = this.publications.findLatestMergeAttempt(publication.id);
    if (
      !latestMerge
      || latestMerge.result !== 'conflicted'
      || latestMerge.conflictPaths.length === 0
      || !publication.conflictChainId
    ) {
      return false;
    }
    const integrationWorkspace = await this.git.ensure({
      taskId: publication.taskId,
      generationId: publication.generationId,
      subtaskId: '__integration__',
    }, this.deps.sourceRoot);
    const candidate = await this.git.describeCandidate(
      integrationWorkspace,
      publication.candidateCommit,
    );
    if (candidate.baseCommit === latestMerge.baseCommit) return false;
    const includesCandidatePath = latestMerge.conflictPaths.some(conflictPath => (
      candidate.changedPaths.some(candidatePath => pathsOverlap(conflictPath, candidatePath))
    ));
    if (includesCandidatePath) return false;
    return this.publications.requeueStaleBaselineConflict(
      publication.id,
      publication.conflictChainId,
      new Date().toISOString(),
    );
  }

  private replayConflict(
    publication: WorkspacePublicationRecord,
  ): ConflictedWorkspacePublication | null {
    const sourceReceipt = this.deps.attemptReceiptRepo.findByAttemptId(
      publication.sourceAttemptId,
    );
    const mergeAttempt = this.publications.findLatestMergeAttempt(publication.id);
    if (!sourceReceipt || !mergeAttempt || !publication.conflictChainId) return null;
    return {
      type: 'conflicted',
      event: {
        schemaVersion: 5,
        configurationRevision: sourceReceipt.configurationRevision,
        type: 'merge_conflict_observed',
        id: mergeConflictObservationId(publication.id, publication.repairAttemptsUsed),
        correlationId: publication.id,
        causationId: mergeAttempt.decisionId,
        occurredAt: mergeAttempt.createdAt,
        sessionId: this.sessionId,
        taskId: publication.taskId,
        subtaskId: publication.subtaskId,
        publicationId: publication.id,
        conflictChainId: publication.conflictChainId,
        authorizedBinding: sourceReceipt.authorizedBinding,
        bindingFingerprint: sourceReceipt.bindingFingerprint,
        sourceAttemptId: publication.sourceAttemptId,
        repairAttemptsUsed: publication.repairAttemptsUsed,
        conflictReplansUsed: publication.conflictReplansUsed,
        conflictingPaths: mergeAttempt.conflictPaths,
      },
    };
  }

  private isStablePredecessorReleased(publication: WorkspacePublicationRecord): boolean {
    const subtasks = this.deps.subtaskRepo.listActiveByTask(publication.taskId);
    const candidates = subtasks.length > 0
      ? subtasks
      : this.deps.subtaskRepo.listByTask(publication.taskId)
        .filter(subtask => subtask.generationId === publication.generationId);
    const orders = new Map<string, number>();
    for (const item of this.deps.dispatchItemRepo.listByTask(publication.taskId)) {
      if (item.generationId !== publication.generationId) continue;
      const current = orders.get(item.subtaskId);
      if (current === undefined || item.batchOrder < current) orders.set(item.subtaskId, item.batchOrder);
    }
    const layers = deriveTopologyLayers(candidates);
    const target = [
      publication.topologyLayer,
      publication.firstDispatchOrder,
      publication.subtaskId,
    ] as const;
    return candidates.every(subtask => {
      if (subtask.id === publication.subtaskId || ['done', 'cancelled'].includes(subtask.status)) return true;
      const key = [
        layers.get(subtask.id) ?? 0,
        orders.get(subtask.id) ?? Number.MAX_SAFE_INTEGER,
        subtask.id,
      ] as const;
      return comparePublicationKeys(key, target) >= 0;
    });
  }

  private async publish(
    publication: WorkspacePublicationRecord,
  ): Promise<WorkspacePublicationOutcome | null> {
    const task = this.deps.taskRuntimeService.findTask(publication.taskId);
    const subtask = this.deps.subtaskRepo.findById(publication.subtaskId);
    if (
      !task
      || task.status === 'cancelled'
      || !subtask
      || subtask.status === 'cancelled'
    ) {
      this.publications.requestCancellation({
        taskId: publication.taskId,
        generationId: publication.generationId,
        subtaskIds: [publication.subtaskId],
        decisionId: `publication_fence_${publication.id}`,
        now: new Date().toISOString(),
      });
      return {
        type: 'cancelled',
        publicationId: publication.id,
        taskId: publication.taskId,
        subtaskId: publication.subtaskId,
        observedIntegrationCommit: null,
      };
    }
    const applyingAt = new Date().toISOString();
    if (!this.publications.markApplying(publication.id, applyingAt)) return null;
    const integrationWorkspace = await this.git.ensure({
      taskId: publication.taskId,
      generationId: publication.generationId,
      subtaskId: '__integration__',
    }, this.deps.sourceRoot);
    const candidate = await this.git.describeCandidate(
      integrationWorkspace,
      publication.candidateCommit,
    );
    const binaryPaths = candidate.changedPaths.filter(path => candidate.filePolicy[path] === 'binary');
    const sourceReceipt = this.deps.attemptReceiptRepo.findByAttemptId(publication.sourceAttemptId);
    if (!sourceReceipt) {
      this.publications.markPending(
        publication.id,
        `missing immutable source receipt ${publication.sourceAttemptId}`,
        new Date().toISOString(),
      );
      return null;
    }
    if (
      sourceReceipt.taskId !== publication.taskId
      || sourceReceipt.subtaskId !== publication.subtaskId
      || sourceReceipt.generationId !== publication.generationId
      || sourceReceipt.authorizedBinding.configurationRevision
        !== sourceReceipt.configurationRevision
    ) {
      this.publications.markPending(
        publication.id,
        `source receipt binding identity mismatch ${publication.sourceAttemptId}`,
        new Date().toISOString(),
      );
      return null;
    }
    const safeProjection = this.findSafeProjection(publication, sourceReceipt);
    const leaseToken = `publication_${randomUUID()}`;
    const publicationAttemptId = `publication:${publication.id}`;
    const lease = this.deps.resourceLeaseService.claim({
      taskId: publication.taskId,
      generationId: publication.generationId,
      subtaskId: publication.subtaskId,
      attemptId: publicationAttemptId,
      workUnitId: sourceReceipt.workUnitId,
      leaseToken,
      claims: binaryPaths.map(path => ({
        partition: {
          kind: 'path' as const,
          mountId: `integration-${publication.taskId}-${publication.generationId}`,
          normalizedRelativePath: path,
        },
        access: 'write' as const,
      })),
    });
    if (lease.type === 'conflict') {
      this.publications.markPending(
        publication.id,
        `binary publication lease is busy: ${lease.conflictingLeases.map(item => item.id).join(', ')}`,
        new Date().toISOString(),
      );
      return null;
    }

    try {
      const merged = await this.git.mergeCandidate(
        integrationWorkspace,
        publication.candidateCommit,
      );
      const now = new Date().toISOString();
      const ordinal = this.publications.countMergeAttempts(publication.id) + 1;
      const auditId = `merge_${publication.id}_${ordinal}`;
      const decisionId = `publication_${publication.id}_${ordinal}`;
      if (merged.type === 'conflicted') {
        const conflictChainId = publication.conflictChainId ?? `conflict_${publication.id}`;
        const summary = `merge conflict: ${merged.conflictPaths.join(', ')}`;
        let cancelled = false;
        this.deps.db.transaction(() => {
          const currentPublication = this.publications.find(publication.id);
          const currentTask = this.deps.taskRuntimeService.findTask(publication.taskId);
          const currentSubtask = this.deps.subtaskRepo.findById(publication.subtaskId);
          if (
            currentPublication?.status === 'cancelling'
            || currentPublication?.status === 'cancelled'
            || currentTask?.status === 'cancelled'
            || currentSubtask?.status === 'cancelled'
          ) {
            cancelled = true;
            this.publications.recordMergeAttempt({
              id: auditId,
              publicationId: publication.id,
              decisionId,
              attemptId: null,
              ordinal,
              attemptKind: ordinal === 1 ? 'automatic' : 'repair',
              baseCommit: merged.baseCommit,
              oursCommit: merged.oursCommit,
              theirsCommit: merged.theirsCommit,
              conflictPaths: merged.conflictPaths,
              filePolicy: merged.filePolicy,
              result: 'failed',
              integrationCommit: null,
              errorSummary: 'merge conflict observed after cancellation fence',
              createdAt: now,
            });
            this.publications.markCancelled(publication.id, null, now);
            return;
          }
          this.publications.recordMergeAttempt({
            id: auditId,
            publicationId: publication.id,
            decisionId,
            attemptId: null,
            ordinal,
            attemptKind: ordinal === 1 ? 'automatic' : 'repair',
            baseCommit: merged.baseCommit,
            oursCommit: merged.oursCommit,
            theirsCommit: merged.theirsCommit,
            conflictPaths: merged.conflictPaths,
            filePolicy: merged.filePolicy,
            result: 'conflicted',
            integrationCommit: null,
            errorSummary: summary,
            createdAt: now,
          });
          this.publications.markConflicted(publication.id, conflictChainId, summary, now);
          this.deps.subtaskRepo.updateStatus(publication.subtaskId, 'awaiting_decision', {
            error: summary,
          });
        })();
        if (cancelled) {
          return {
            type: 'cancelled',
            publicationId: publication.id,
            taskId: publication.taskId,
            subtaskId: publication.subtaskId,
            observedIntegrationCommit: null,
          };
        }
        return {
          type: 'conflicted',
          event: {
            schemaVersion: 5,
            configurationRevision: sourceReceipt.configurationRevision,
            type: 'merge_conflict_observed',
            id: mergeConflictObservationId(publication.id, publication.repairAttemptsUsed),
            correlationId: publication.id,
            causationId: decisionId,
            occurredAt: now,
            sessionId: this.sessionId,
            taskId: publication.taskId,
            subtaskId: publication.subtaskId,
            publicationId: publication.id,
            conflictChainId,
            authorizedBinding: sourceReceipt.authorizedBinding,
            bindingFingerprint: sourceReceipt.bindingFingerprint,
            sourceAttemptId: publication.sourceAttemptId,
            repairAttemptsUsed: publication.repairAttemptsUsed,
            conflictReplansUsed: publication.conflictReplansUsed,
            conflictingPaths: merged.conflictPaths,
          },
        };
      }

      const workspace = this.deps.workspaceRepository.findByIdentity(
        publication.taskId,
        publication.generationId,
        publication.subtaskId,
      );
      let cancelled = false;
      this.deps.db.transaction(() => {
        const currentPublication = this.publications.find(publication.id);
        const currentTask = this.deps.taskRuntimeService.findTask(publication.taskId);
        const currentSubtask = this.deps.subtaskRepo.findById(publication.subtaskId);
        if (
          currentPublication?.status === 'cancelling'
          || currentPublication?.status === 'cancelled'
          || currentTask?.status === 'cancelled'
          || currentSubtask?.status === 'cancelled'
        ) {
          cancelled = true;
          this.publications.recordMergeAttempt({
            id: auditId,
            publicationId: publication.id,
            decisionId,
            attemptId: ordinal === 1 ? null : publication.sourceAttemptId,
            ordinal,
            attemptKind: ordinal === 1 ? 'automatic' : 'repair',
            baseCommit: merged.baseCommit,
            oursCommit: merged.oursCommit,
            theirsCommit: merged.theirsCommit,
            conflictPaths: [],
            filePolicy: merged.filePolicy,
            result: 'failed',
            integrationCommit: merged.integrationCommit,
            errorSummary: 'integration commit observed after cancellation fence; result not published',
            createdAt: now,
          });
          this.publications.markCancelled(publication.id, merged.integrationCommit, now);
          return;
        }
        this.publications.recordMergeAttempt({
          id: auditId,
          publicationId: publication.id,
          decisionId,
          attemptId: ordinal === 1 ? null : publication.sourceAttemptId,
          ordinal,
          attemptKind: ordinal === 1 ? 'automatic' : 'repair',
          baseCommit: merged.baseCommit,
          oursCommit: merged.oursCommit,
          theirsCommit: merged.theirsCommit,
          conflictPaths: [],
          filePolicy: merged.filePolicy,
          result: 'integrated',
          integrationCommit: merged.integrationCommit,
          errorSummary: null,
          createdAt: now,
        });
        for (const handoff of publication.originalCompletion.handoffs) {
          if (!safeProjection) {
            throw new Error(
              `safe projection is required for handoff publication: ${publication.sourceAttemptId}`,
            );
          }
          const summary = handoff.items.map(item => (
            item.type === 'text'
              ? { key: item.key, type: item.type, summary: `Authorized upstream result for ${item.key}` }
              : { key: item.key, type: item.type, paths: item.paths }
          ));
          const summaryHash = `sha256:${createHash('sha256')
            .update(JSON.stringify(summary))
            .digest('hex')}`;
          const referenceId = resultReferenceId({
            accountId: this.deps.accountId ?? 'local-default',
            taskId: publication.taskId,
            generationId: publication.generationId,
            sourceSubtaskId: publication.subtaskId,
            targetSubtaskId: handoff.toSubtaskId,
            attemptId: publication.sourceAttemptId,
            resultId: safeProjection.resultId,
          });
          const reference = this.results.createReference({
            referenceId,
            resultId: safeProjection.resultId,
            accountId: this.deps.accountId ?? 'local-default',
            taskId: publication.taskId,
            generationId: publication.generationId,
            sourceSubtaskId: publication.subtaskId,
            targetSubtaskId: handoff.toSubtaskId,
            edgeKey: `${publication.subtaskId}->${handoff.toSubtaskId}`,
            requiredItems: handoff.items.map(item => item.key),
            readScope: {
              kind: 'direct_dependency',
              offset: 0,
              length: safeProjection.byteLength,
              summaryHash,
            },
            createdAt: now,
          });
          const items: PersistedSubtaskHandoffItem[] = handoff.items.map(item => (
            item.type === 'text'
              ? {
                  key: item.key,
                  type: 'result_reference',
                  referenceId,
                  summary: `Authorized upstream result for ${item.key}`,
                }
              : { key: item.key, type: 'artifact', paths: [...item.paths] }
          ));
          this.handoffs.insert({
            taskId: publication.taskId,
            fromSubtaskId: publication.subtaskId,
            toSubtaskId: handoff.toSubtaskId,
            attemptId: publication.sourceAttemptId,
            items,
            resultReference: reference,
            completionSchemaVersion: publication.originalCompletion.completionSchemaVersion,
            createdAt: now,
          });
        }
        this.deps.subtaskRepo.updateStatus(publication.subtaskId, 'done', {
          result: publication.originalCompletion.body,
          artifacts: publication.originalCompletion.artifacts,
          verification: {
            warnings: publication.originalCompletion.warnings,
            completionSchemaVersion: publication.originalCompletion.completionSchemaVersion,
          },
          error: null,
        });
        this.publications.markIntegrated(publication.id, merged.integrationCommit, now);
        if (workspace) {
          this.deps.workspaceRepository.upsert({
            ...workspace,
            status: 'done',
            updatedAt: now,
          });
        }
      })();
      if (cancelled) {
        return {
          type: 'cancelled',
          publicationId: publication.id,
          taskId: publication.taskId,
          subtaskId: publication.subtaskId,
          observedIntegrationCommit: merged.integrationCommit,
        };
      }
      // Git publication 成功后才把已验证 artifact 发布为用户可见产物；
      // 用户产物发布失败只降级为 warning，不影响 durable publication 事实。
      const userArtifacts = await this.publishUserArtifacts(publication, integrationWorkspace);
      return {
        type: 'integrated',
        publicationId: publication.id,
        taskId: publication.taskId,
        subtaskId: publication.subtaskId,
        sourceAttemptId: publication.sourceAttemptId,
        agentClassName: publication.agentClassName,
        integrationCommit: merged.integrationCommit,
        resultId: safeProjection?.resultId ?? null,
        output: publication.originalCompletion.body,
        warnings: publication.originalCompletion.warnings,
        userArtifacts,
      };
    } catch (error) {
      this.publications.markPending(
        publication.id,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
      );
      throw error;
    } finally {
      this.deps.resourceLeaseService.release(publicationAttemptId, leaseToken);
    }
  }

  private async publishUserArtifacts(
    publication: WorkspacePublicationRecord,
    integrationWorkspace: Awaited<ReturnType<ManagedGitWorkspaceService['ensure']>>,
  ): Promise<ArtifactProjection[]> {
    const service = this.deps.userArtifactPublication;
    if (!service) return [];
    const sources = this.artifactSources(publication, integrationWorkspace);
    if (sources.length === 0) return [];
    const task = this.deps.taskRuntimeService.findTask(publication.taskId);
    try {
      const outcome = await service.publishIntegratedArtifacts({
        sessionId: this.sessionId,
        accountId: this.deps.accountId ?? 'local-default',
        taskId: publication.taskId,
        taskTitle: task?.title ?? publication.taskId,
        generationId: publication.generationId,
        subtaskId: publication.subtaskId,
        publicationId: publication.id,
        integratedWorkspaceRoot: integrationWorkspace.filesPath,
        userWorkspaceRoot: await this.deps.resolveUserWorkspaceRoot?.(this.sessionId)
          ?? undefined,
        sources,
      });
      for (const failure of outcome.failures) {
        console.warn(
          `user artifact publication skipped ${failure.sourceRelativePath}: ${failure.reason}`,
        );
      }
      return outcome.projections;
    } catch (error) {
      console.warn(
        `user artifact publication failed for ${publication.id}:`
        + ` ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async reconcileIntegratedArtifacts(
    taskId: string,
    generationId: string,
  ): Promise<void> {
    if (!this.deps.userArtifactPublication) return;
    const publications = this.publications.listIntegratedByTaskIds([taskId])
      .filter(publication => (
        publication.generationId === generationId
        && publication.originalCompletion.artifacts.length > 0
      ));
    if (publications.length === 0) return;
    const integrationWorkspace = await this.git.ensure({
      taskId,
      generationId,
      subtaskId: '__integration__',
    }, this.deps.sourceRoot);
    for (const publication of publications) {
      await this.publishUserArtifacts(publication, integrationWorkspace);
    }
  }

  private artifactSources(
    publication: WorkspacePublicationRecord,
    integrationWorkspace: Awaited<ReturnType<ManagedGitWorkspaceService['ensure']>>,
  ): Array<{ sourceRelativePath: string }> {
    const sourceWorkspace = this.deps.workspaceRepository.findByIdentity(
      publication.taskId,
      publication.generationId,
      publication.subtaskId,
    );
    const sourceFilesRoot = sourceWorkspace
      ? join(fileURLToPath(sourceWorkspace.rootUri), 'files')
      : null;
    return publication.originalCompletion.artifacts.flatMap(path => {
      if (typeof path !== 'string' || path.trim().length === 0) return [];
      if (!isAbsolute(path)) return [{ sourceRelativePath: path }];
      for (const root of [sourceFilesRoot, integrationWorkspace.filesPath]) {
        if (!root) continue;
        const candidate = relative(root, path);
        if (
          candidate
          && !candidate.startsWith('..')
          && !candidate.includes(`..${sep}`)
          && !isAbsolute(candidate)
        ) {
          return [{ sourceRelativePath: candidate.split(sep).join('/') }];
        }
      }
      return [];
    });
  }

  private findSafeProjection(
    publication: WorkspacePublicationRecord,
    receipt: import('../storage/executor-attempt-receipt-repo.js').ExecutorAttemptReceipt,
  ) {
    const resultObjects = receipt.parsing?.resultObjects as {
      safeProjectionId?: string | null;
    } | null | undefined;
    const result = resultObjects?.safeProjectionId
      ? this.results.findObject(resultObjects.safeProjectionId)
      : this.results.findObjectByAttempt({
          accountId: this.deps.accountId ?? 'local-default',
          taskId: publication.taskId,
          attemptId: publication.sourceAttemptId,
          kind: 'safe_projection',
        });
    if (!result) return null;
    if (
      result.accountId !== (this.deps.accountId ?? 'local-default')
      || result.taskId !== publication.taskId
      || result.generationId !== publication.generationId
      || result.sourceSubtaskId !== publication.subtaskId
      || result.attemptId !== publication.sourceAttemptId
    ) {
      throw new Error(
        `safe projection identity mismatch for handoff publication: ${publication.sourceAttemptId}`,
      );
    }
    return result;
  }
}

function resultReferenceId(input: {
  accountId: string;
  taskId: string;
  generationId: string;
  sourceSubtaskId: string;
  targetSubtaskId: string;
  attemptId: string;
  resultId: string;
}): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 32);
  return `result_reference_${hash}`;
}

function deriveTopologyLayers(
  subtasks: ReturnType<SubtaskRepo['listByTask']>,
): Map<string, number> {
  const byId = new Map(subtasks.map(subtask => [subtask.id, subtask]));
  const layers = new Map<string, number>();
  const visit = (id: string, visiting = new Set<string>()): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`cyclic Subtask dependency in publication ordering: ${id}`);
    visiting.add(id);
    const subtask = byId.get(id);
    const layer = subtask
      ? subtask.dependencies.reduce((maximum, dependency) => (
          Math.max(maximum, visit(dependency.fromSubtaskId, visiting) + 1)
        ), 0)
      : 0;
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  };
  for (const subtask of subtasks) visit(subtask.id);
  return layers;
}

function comparePublicationKeys(
  left: readonly [number, number, string],
  right: readonly [number, number, string],
): number {
  return left[0] - right[0]
    || left[1] - right[1]
    || left[2].localeCompare(right[2]);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}
