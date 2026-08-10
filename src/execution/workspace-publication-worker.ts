import { randomUUID } from 'node:crypto';
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

export interface IntegratedWorkspacePublication {
  type: 'integrated';
  publicationId: string;
  taskId: string;
  subtaskId: string;
  sourceAttemptId: string;
  agentClassName: string;
  integrationCommit: string;
  output: string;
  warnings: string[];
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
  sourceRoot: string;
  workspaceStore: WorkspaceStore;
  workspaceRepository: WorkspaceRepositoryPort;
  subtaskRepo: SubtaskRepo;
  attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  resourceLeaseService: ResourceLeaseService;
  dispatchItemRepo: KernelDispatchItemRepo;
  taskRuntimeService: TaskRuntimeService;
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
  private readonly reconciledGenerations = new Set<string>();
  private readonly activeDrains = new Map<string, Promise<WorkspacePublicationOutcome[]>>();

  constructor(private readonly deps: WorkspacePublicationWorkerDeps) {
    this.publications = new WorkspacePublicationRepo(deps.db);
    this.handoffs = new SubtaskHandoffRepo(deps.db);
    this.git = new ManagedGitWorkspaceService(deps.workspaceStore);
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
    while (true) {
      const publication = this.publications.findNextBlocking(taskId, generationId);
      if (!publication || publication.status !== 'pending') break;
      if (!this.isStablePredecessorReleased(publication)) break;
      const outcome = await this.publish(publication);
      if (!outcome) break;
      outcomes.push(outcome);
      if (outcome.type === 'conflicted') break;
    }
    return outcomes;
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
            type: 'merge_conflict_observed',
            id: `event_${conflictChainId}_${ordinal}`,
            correlationId: publication.id,
            causationId: decisionId,
            occurredAt: now,
            sessionId: this.deps.sessionId,
            taskId: publication.taskId,
            subtaskId: publication.subtaskId,
            publicationId: publication.id,
            conflictChainId,
            agentClassName: publication.agentClassName,
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
          this.handoffs.insert({
            taskId: publication.taskId,
            fromSubtaskId: publication.subtaskId,
            toSubtaskId: handoff.toSubtaskId,
            attemptId: publication.sourceAttemptId,
            items: handoff.items,
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
      return {
        type: 'integrated',
        publicationId: publication.id,
        taskId: publication.taskId,
        subtaskId: publication.subtaskId,
        sourceAttemptId: publication.sourceAttemptId,
        agentClassName: publication.agentClassName,
        integrationCommit: merged.integrationCommit,
        output: publication.originalCompletion.body,
        warnings: publication.originalCompletion.warnings,
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
