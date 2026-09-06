import type { KernelDecisionApplicationRecord } from '../kernel/kernel-workflow.js';
import type { TaskCancellationCoordinator } from './task-cancellation-coordinator.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';

/**
 * Uncertain cancellation reconciliation (2026-09-06 plan §5.3.5).
 *
 * `uncertain` is a durable recovery state with a deterministic reconciliation
 * path — never a hidden retry queue. For every uncertain `cancel_task` /
 * `cancel_subtasks` application this module evaluates the durable
 * postconditions and resolves the application to one of:
 *
 * - `already_applied`: every durable cancellation effect exists; the
 *   application row is marked applied and the asynchronous drain continues.
 * - `replayed`: safe effects were missing; the same cancellation identity is
 *   re-applied idempotently (TaskCancellationCoordinator.apply converges) and
 *   the application row is marked applied.
 * - `unresolved`: state is contradictory (for example the graph generation
 *   changed); admission stays closed and the diagnostic names the phase.
 */

export interface CancellationReconciliationEntry {
  taskId: string;
  decisionId: string;
  outcome: 'already_applied' | 'replayed' | 'unresolved';
  diagnostics: string[];
}

export interface CancellationReconciliationDeps {
  store: {
    listUncertainApplications?: (
      actions?: Array<'cancel_task' | 'cancel_subtasks'>,
      taskId?: string,
    ) => KernelDecisionApplicationRecord[];
    resolveUncertainApplication?: (
      decisionId: string,
      outcome: 'applied' | 'retry',
      now: string,
    ) => void;
  };
  coordinator: Pick<TaskCancellationCoordinator, 'apply' | 'completionBlockedReasons'>;
  taskRuntimeService: Pick<TaskRuntimeService, 'findTask'>;
  /** Fired after an application resolves so the caller can drain attempts. */
  onResolved?(taskId: string): void;
  now?(): string;
}

/** Blocking categories that the asynchronous drain resolves after apply. */
const DRAIN_CATEGORIES = new Set(['dispatch', 'kernel_application']);

export function reconcileUncertainCancellations(
  deps: CancellationReconciliationDeps,
  taskId?: string,
): CancellationReconciliationEntry[] {
  const listUncertain = deps.store.listUncertainApplications?.bind(deps.store);
  const resolveUncertain = deps.store.resolveUncertainApplication?.bind(deps.store);
  if (!listUncertain || !resolveUncertain) return [];
  const now = deps.now ?? (() => new Date().toISOString());
  const entries: CancellationReconciliationEntry[] = [];
  for (const application of listUncertain(['cancel_task', 'cancel_subtasks'], taskId)) {
    const decision = application.decision;
    const action = decision.action;
    if (action.type !== 'cancel_task' && action.type !== 'cancel_subtasks') continue;
    const task = deps.taskRuntimeService.findTask(action.taskId);
    const blocking = deps.coordinator.completionBlockedReasons(
      action.taskId,
      action.type === 'cancel_task' ? action.generationId : null,
      decision.id,
    );
    const durableResidue = blocking.filter(category => !DRAIN_CATEGORIES.has(category));
    if (task?.status === 'cancelled' && durableResidue.length === 0) {
      resolveUncertain(decision.id, 'applied', now());
      deps.onResolved?.(action.taskId);
      entries.push({
        taskId: action.taskId,
        decisionId: decision.id,
        outcome: 'already_applied',
        diagnostics: blocking,
      });
      continue;
    }
    try {
      deps.coordinator.apply(decision as Parameters<TaskCancellationCoordinator['apply']>[0]);
      resolveUncertain(decision.id, 'applied', now());
      deps.onResolved?.(action.taskId);
      entries.push({
        taskId: action.taskId,
        decisionId: decision.id,
        outcome: 'replayed',
        diagnostics: [],
      });
    } catch (error) {
      // Contradictory state: keep admission closed and surface the exact
      // phase instead of collapsing into a generic retry loop.
      entries.push({
        taskId: action.taskId,
        decisionId: decision.id,
        outcome: 'unresolved',
        diagnostics: [
          `application_phase=${error instanceof Error ? error.message : String(error)}`,
          `blocking=${blocking.join(',') || 'none'}`,
          `task_status=${task?.status ?? 'missing'}`,
        ],
      });
    }
  }
  return entries;
}
