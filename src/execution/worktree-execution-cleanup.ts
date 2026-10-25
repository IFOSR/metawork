import type { Task } from '../core/types.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { SubtaskRepo } from '../storage/subtask-repo.js';
import type { WorkspaceExecutionBindingRepo } from '../storage/workspace-execution-binding-repo.js';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

export interface WorktreeCleanupRetention {
  taskId: string;
  generationId: string;
  reasons: string[];
}

export interface WorktreeCleanupOutcome {
  removed: Array<{ taskId: string; generationId: string }>;
  retained: WorktreeCleanupRetention[];
  failures: Array<{ taskId: string; generationId: string; reason: string }>;
}

export interface WorktreeExecutionCleanupDeps {
  workspaceStore: WorkspaceStore;
  bindingRepo: WorkspaceExecutionBindingRepo;
  subtaskRepo: Pick<SubtaskRepo, 'listByTask'>;
  residueReader: {
    blockingReasons(taskId: string, generationId: string | null): readonly string[];
  };
  /**
   * Publication work that is not decided yet. A failed delivery is retried by
   * the publication chain, so its candidate directory must stay available.
   */
  publicationReader?: {
    hasUndecidedDelivery(taskId: string, generationId: string): boolean;
  };
  findTask(taskId: string): Pick<Task, 'id' | 'status'> | null;
  /**
   * Drops stale Git worktree metadata for the retired Generation. Removing the
   * directory without this leaves a registration that blocks a later retry.
   */
  pruneManagedWorktrees?(taskId: string, generationId: string): Promise<void>;
  /** Removes the Generation-owned bare repository after all delivery work is settled. */
  removeManagedRepository?(taskId: string, generationId: string): Promise<void>;
  /** Durable diagnostic sink; cleanup failures must never disappear silently. */
  recordDiagnostic?(input: {
    taskId: string;
    generationId: string;
    kind: 'cleanup_failed' | 'cleanup_retained';
    reason: string;
  }): void;
  now?: () => string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Retires the internal Worktree execution directory of a Generation
 * (2026-10-25 design §8).
 *
 * The directory is Runtime state, not user data: it is removed only when the
 * Generation can no longer produce a side effect — every Subtask is terminal,
 * no publication is pending/conflicted/uncertain or awaiting acceptance, no
 * dispatch, lease, retry wake, replan or uncertain Kernel application remains.
 * Anything uncertain keeps the directory so recovery can still inspect it.
 */
export class WorktreeExecutionCleanupService {
  constructor(private readonly deps: WorktreeExecutionCleanupDeps) {}

  /** Plans cleanup without touching the filesystem; used by tests and diagnostics. */
  plan(taskId: string): { removable: string[]; retained: WorktreeCleanupRetention[] } {
    const task = this.deps.findTask(taskId);
    const removable: string[] = [];
    const retained: WorktreeCleanupRetention[] = [];
    for (const binding of this.deps.bindingRepo.listByTask(taskId)) {
      if (binding.executionMode !== 'worktree' || binding.cleanedAt) continue;
      const reasons = this.retentionReasons(task, binding.generationId);
      if (reasons.length > 0) retained.push({ taskId, generationId: binding.generationId, reasons });
      else removable.push(binding.generationId);
    }
    return { removable, retained };
  }

  async cleanupTask(taskId: string): Promise<WorktreeCleanupOutcome> {
    const outcome: WorktreeCleanupOutcome = { removed: [], retained: [], failures: [] };
    const { removable, retained } = this.plan(taskId);
    outcome.retained.push(...retained);
    for (const retention of retained) {
      this.deps.recordDiagnostic?.({
        taskId,
        generationId: retention.generationId,
        kind: 'cleanup_retained',
        reason: retention.reasons.join(','),
      });
    }
    for (const generationId of removable) {
      const rootPath = this.deps.workspaceStore.planGenerationRoot(taskId, generationId);
      try {
        if (existsSync(rootPath)) {
          await this.deps.workspaceStore.removeWorkspaceUri(pathToFileURL(rootPath).href);
        }
        await this.deps.pruneManagedWorktrees?.(taskId, generationId);
        await this.deps.removeManagedRepository?.(taskId, generationId);
        this.deps.bindingRepo.markCleaned(taskId, generationId, this.deps.now?.() ?? new Date().toISOString());
        outcome.removed.push({ taskId, generationId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        outcome.failures.push({ taskId, generationId, reason });
        // A failed recursive delete never falls back to deleting the user's
        // Workspace: only the managed generation root is ever a target.
        this.deps.recordDiagnostic?.({ taskId, generationId, kind: 'cleanup_failed', reason });
      }
    }
    return outcome;
  }

  async cleanupTerminalTasks(limit = 50): Promise<WorktreeCleanupOutcome> {
    const aggregate: WorktreeCleanupOutcome = { removed: [], retained: [], failures: [] };
    let processed = 0;
    for (const taskId of this.deps.bindingRepo.listTasksWithUncleanedWorktrees(limit)) {
      if (processed >= limit) break;
      processed += 1;
      const outcome = await this.cleanupTask(taskId);
      aggregate.removed.push(...outcome.removed);
      aggregate.retained.push(...outcome.retained);
      aggregate.failures.push(...outcome.failures);
    }
    return aggregate;
  }

  private retentionReasons(
    task: Pick<Task, 'id' | 'status'> | null,
    generationId: string,
  ): string[] {
    if (!task) return ['task_missing'];
    const reasons: string[] = [...this.deps.residueReader.blockingReasons(task.id, generationId)];
    if (this.deps.publicationReader?.hasUndecidedDelivery(task.id, generationId)) {
      reasons.push('publication_undecided');
    }
    const subtasks = this.deps.subtaskRepo.listByTask(task.id)
      .filter(subtask => subtask.generationId === generationId);
    const generationTerminal = subtasks.length > 0
      && subtasks.every(subtask => ['done', 'cancelled', 'blocked'].includes(subtask.status));
    // A Task that is still active may keep its current Generation for follow-up
    // rounds; only a terminal Task or a retired Generation is reclaimable.
    if (!TERMINAL.has(task.status) && !generationTerminal) reasons.push('task_active');
    return [...new Set(reasons)];
  }
}
