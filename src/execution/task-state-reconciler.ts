// Reconciles half-cancelled task state left behind by historical races:
// orphaned dispatch items, conversation slots held by terminal tasks, and
// zombie schedule entries. Runs at server start, periodically, and on demand
// through `metawork maintenance reconcile-tasks`.
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { createDatabase } from '../storage/database.js';
import { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';
import { ControlDispatchItemRepo } from '../storage/dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { WorkUnitClaimService } from './work-unit-claim-service.js';
import {
  TaskResidueReader,
  type TaskResidueCategory,
} from './task-residue-reader.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import { TaskRepo } from '../storage/task-repo.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import {
  TaskStateChangeRepo,
  TaskStateProjectionOutbox,
} from '../storage/task-state-change-repo.js';
import {
  createSqliteTaskLifecyclePort,
  createSqliteTaskStateTransaction,
} from '../storage/task-lifecycle-port-adapter.js';
import { SqliteTaskStateFactsReader } from '../storage/task-state-facts-reader.js';
import { readPendingTaskResult } from '../storage/pending-task-result.js';
import { TaskOperationResultRepo } from '../storage/task-operation-result-repo.js';
import { TaskStateAuthority } from '../task/task-state-authority.js';
import type { Dependency } from '../core/types.js';

export interface TaskStateReconcilerReport {
  ok: boolean;
  /** Human-readable lines for an explicit `maintenance reconcile-tasks` run. */
  lines: string[];
  /**
   * Lines describing state this pass actually changed. Background callers print
   * only these: a no-op pass has nothing to say (§A3 of the 2026-10-22 review).
   */
  changes: string[];
  /** True when this pass wrote any reconciled state. */
  changed: boolean;
  closedDispatchItems: number;
  releasedSlots: number;
  /** Slots retained because live or uncertain residue has not converged. */
  retainedSlots: number;
  retainedSlotResidue: ReadonlyArray<{
    conversationId: string;
    taskId: string;
    residue: readonly TaskResidueCategory[];
  }>;
  closedScheduleEntries: number;
}

export async function runTaskStateReconciler(input: {
  installRoot?: string;
  db?: import('better-sqlite3').Database;
  now?: () => string;
}): Promise<TaskStateReconcilerReport> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.db) {
    return reconcile(input.db, now);
  }
  const paths = resolveMetaWorkPaths(undefined, input.installRoot);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  let db: import('better-sqlite3').Database;
  try {
    db = createDatabase(accountPaths.database);
  } catch {
    // A missing or migrating database has nothing to reconcile.
    return {
      ok: true,
      lines: ['no reconcilable database found; nothing to do'],
      changes: [],
      changed: false,
      closedDispatchItems: 0,
      releasedSlots: 0,
      retainedSlots: 0,
      retainedSlotResidue: [],
      closedScheduleEntries: 0,
    };
  }
  try {
    return reconcile(db, now);
  } finally {
    db.close();
  }
}

function reconcile(
  db: import('better-sqlite3').Database,
  now: () => string,
): TaskStateReconcilerReport {
  const scheduler = new ConversationTaskSchedulerRepo(db);
  const residueReader = new TaskResidueReader({
    db,
    dispatchItemRepo: new ControlDispatchItemRepo(db),
    publicationRepo: new WorkspacePublicationRepo(db),
    workUnitClaimService: new WorkUnitClaimService(new WorkUnitRepo(db)),
  });
  const lines: string[] = [];
  const changes: string[] = [];

  const record = (line: string): void => {
    lines.push(line);
    changes.push(line);
  };

  // 1. Dispatch items for terminal tasks that never reached a live backend.
  //    `cancelling`, `uncertain` and backend-backed items are left alone: they
  //    are resolved along the durable Kernel path, never by a SQL shortcut.
  const closedDispatchItems = db.prepare(`
    UPDATE dispatch_items AS item
    SET status = 'cancelled',
        terminal_at = COALESCE(terminal_at, ?),
        cancel_requested_at = COALESCE(cancel_requested_at, ?),
        cancelled_at = COALESCE(cancelled_at, ?),
        error_summary = COALESCE(error_summary, 'reconciled: task already terminal'),
        updated_at = ?
    WHERE item.status IN ('pending_launch', 'launching')
      AND item.work_unit_id IS NULL
      AND item.sandbox_container_id IS NULL
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = item.task_id AND tasks.status IN ('cancelled', 'succeeded', 'failed')
      )
  `).run(now(), now(), now(), now()).changes;
  if (closedDispatchItems > 0) {
    record(`closed ${closedDispatchItems} orphaned dispatch item(s) for terminal tasks`);
  }

  // 1b. Replan requests that can never run because their Task already reached
  //     a terminal conclusion. They are not live work, but they keep the slot
  //     `releasing` forever (observed 2026-11-11: a failed research Task kept a
  //     pending_quiescence replan, so the queued retry never started).
  //     Only pre-planning and availability-waiting rows are closed; a submitted
  //     proposal and an active planning claim stay on the durable Kernel path.
  const closedReplanRequests = db.prepare(`
    UPDATE generation_replan_requests
    SET status = 'cancelled',
        error_summary = COALESCE(error_summary, 'reconciled: task already terminal'),
        updated_at = ?
    WHERE status IN ('pending_quiescence', 'waiting_for_availability')
      AND submitted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = generation_replan_requests.task_id
          AND tasks.status IN ('cancelled', 'succeeded', 'failed')
      )
  `).run(now()).changes;
  if (closedReplanRequests > 0) {
    record(`closed ${closedReplanRequests} orphaned replan request(s) for terminal tasks`);
  }

  // 1c. A Task can be left `running` when its block application was cut short by
  //     a process death (observed 2026-11-11): the Subtask is `blocked`, but the
  //     Task itself never reached `needs_action`, so no surface offers a resume
  //     and the Task looks "executing" forever. When no live dispatch, lease,
  //     retry wake, replan or other residue can still advance it, conclude the
  //     block through the Task state authority instead of guessing a status.
  const stalledTasks = db.prepare(`
    SELECT id, state_version, dependencies_json
    FROM tasks
    WHERE status = 'running'
      AND EXISTS (
        SELECT 1 FROM subtasks WHERE subtasks.task_id = tasks.id AND subtasks.status = 'blocked'
      )
      AND NOT EXISTS (
        SELECT 1 FROM dispatch_items
        WHERE dispatch_items.task_id = tasks.id
          AND dispatch_items.status IN ('pending_launch', 'launching', 'running', 'cancelling', 'uncertain')
      )
  `).all() as Array<{ id: string; state_version: number; dependencies_json: string }>;
  let parkedStalledTasks = 0;
  for (const stalled of stalledTasks) {
    // Any surviving residue (a future retry wake, an open lease, a service
    // effect, ...) means the runtime may still advance this Task; the
    // maintenance pass must not preempt it.
    const residue = residueReader.blockingReasons(stalled.id, null);
    if (residue.some(category => category !== 'generation_replan')) continue;
    if (residue.includes('generation_replan')) {
      // A `pending_quiescence` Job without a quiescence token only advances
      // from a generation observation, and no live work is left to emit one.
      // It is the same interrupted-application residue as the half-applied
      // block. A Job that already owns a token is scheduled on the Planner
      // path and is left alone.
      const cancelledIdleReplans = db.prepare(`
        UPDATE generation_replan_requests
        SET status = 'cancelled',
            error_summary = COALESCE(error_summary, 'reconciled: no live work can reach quiescence'),
            updated_at = ?
        WHERE task_id = ? AND status = 'pending_quiescence'
          AND submitted_at IS NULL AND quiescence_token IS NULL
      `).run(now(), stalled.id).changes;
      if (cancelledIdleReplans === 0) continue;
      record(`cancelled ${cancelledIdleReplans} idle replan request(s) for stalled Task ${stalled.id}`);
    }
    if (residueReader.blockingReasons(stalled.id, null).length > 0) continue;
    const dependencies = JSON.parse(stalled.dependencies_json) as Dependency[];
    const reason = '执行过程被中断，需要继续未完成部分。';
    if (dependencies.some(dependency => dependency.status === 'waiting' && dependency.description === reason)) {
      continue;
    }
    const authority = createTaskStateWriter(db, residueReader);
    const reconciled = authority.reconcile({
      taskId: stalled.id,
      decisionId: `reconcile_stalled_${stalled.id}_v${stalled.state_version}`,
      operationKey: `reconcile_stalled:${stalled.id}:${stalled.state_version}`,
      actor: 'task-domain',
      reason,
      facts: () => {
        const current = new TaskRepo(db).findById(stalled.id);
        if (!current) return [];
        new TaskRepo(db).update(stalled.id, {
          dependencies: [...current.dependencies, {
            taskId: stalled.id,
            type: 'manual',
            description: reason,
            status: 'waiting',
            createdAt: now(),
          }],
        });
        return [];
      },
    });
    if (!reconciled?.applied || reconciled.task.status !== 'needs_action') continue;
    parkedStalledTasks += 1;
    record(`parked stalled Task ${stalled.id} as needing action (blocked Subtask, no live work)`);
  }
  if (parkedStalledTasks > 0) {
    record(`parked ${parkedStalledTasks} stalled Task(s) that would otherwise look executing`);
  }

  // 2. Conversation slots held by terminal tasks (blocked tasks keep their
  //    slot on purpose — the Planner asks the user how to proceed).
  const staleSlots = db.prepare(`
    SELECT conversation_id, active_task_id FROM conversation_task_slots
    WHERE active_task_id IS NOT NULL AND state IN ('occupied', 'releasing')
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = conversation_task_slots.active_task_id
          AND tasks.status IN ('cancelled', 'succeeded', 'failed')
      )
  `).all() as Array<{ conversation_id: string; active_task_id: string }>;
  let releasedSlots = 0;
  const retainedSlotResidue: Array<{
    conversationId: string;
    taskId: string;
    residue: readonly TaskResidueCategory[];
  }> = [];
  for (const slot of staleSlots) {
    // A terminal Task status is not proof that its side effects converged: the
    // slot may only be released once the unified residue reader is clean.
    const residue = residueReader.blockingReasons(slot.active_task_id, null);
    if (residue.length > 0) {
      retainedSlotResidue.push({
        conversationId: slot.conversation_id,
        taskId: slot.active_task_id,
        residue,
      });
      lines.push(
        `retained conversation slot in ${slot.conversation_id}: task ${slot.active_task_id} `
        + `still owns ${residue.join(', ')}`,
      );
      continue;
    }
    // This maintenance pass may run before AccountRuntime is composed. It may
    // release stale capacity, but it must not reserve a successor that it
    // cannot launch. AccountStartupRecoveryService performs promotion and
    // Kernel-authorized launch through the normal account path.
    const released = db.transaction(() => {
      const current = scheduler.getSlot(slot.conversation_id);
      if (current.activeTaskId !== slot.active_task_id || residueReader.hasResidue(slot.active_task_id)) return false;
      return scheduler.releaseSlot(slot.conversation_id, slot.active_task_id, now(), current);
    }).immediate();
    releasedSlots += 1;
    if (released) record(`released stale conversation slot in ${slot.conversation_id}`);
  }
  if (releasedSlots > 0) {
    record(`released ${releasedSlots} conversation slot(s) held by terminal tasks`);
  }

  // 3. Schedule entries still marked running/queued for terminal tasks.
  const closedScheduleEntries = db.prepare(`
    UPDATE task_schedule_entries AS entry
    SET state = 'terminal', last_scheduled_at = COALESCE(last_scheduled_at, ?)
    WHERE entry.state IN ('queued', 'eligible', 'reserved', 'running')
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = entry.task_id AND tasks.status IN ('cancelled', 'succeeded', 'failed')
      )
  `).run(now()).changes;
  if (closedScheduleEntries > 0) {
    record(`closed ${closedScheduleEntries} schedule entr(ies) for terminal tasks`);
  }

  const ok = true;
  if (lines.length === 0) lines.push('task state is consistent; nothing to reconcile');
  return {
    ok,
    lines,
    changes,
    changed: changes.length > 0,
    closedDispatchItems,
    releasedSlots,
    retainedSlots: retainedSlotResidue.length,
    retainedSlotResidue,
    closedScheduleEntries,
  };
}

/**
 * The Task state authority needs the same facts reader the running Server uses.
 * Maintenance composes a short-lived one; it only writes through the durable
 * lifecycle port (state change ledger + projection outbox).
 */
function createTaskStateWriter(
  db: import('better-sqlite3').Database,
  residue: TaskResidueReader,
): TaskStateAuthority {
  const taskRepo = new TaskRepo(db);
  const subtaskRepo = new SubtaskRepo(db);
  const workGraphRevisionRepo = new WorkGraphRevisionRepo(db);
  const stateChanges = new TaskStateChangeRepo(db);
  const lifecycle = createSqliteTaskLifecyclePort(db, {
    taskRepo,
    subtaskRepo,
    stateChanges,
    projectionOutbox: new TaskStateProjectionOutbox(db),
    workGraphRevisionRepo,
  });
  const facts = new SqliteTaskStateFactsReader({
    db,
    taskRepo,
    subtaskRepo,
    workGraphRevisionRepo,
    readPendingResult: taskId => readPendingTaskResult(db, taskId),
    residue,
    operationResults: new TaskOperationResultRepo(db),
  });
  return new TaskStateAuthority({
    facts,
    stateChanges,
    taskRepo,
    lifecycle,
    transaction: createSqliteTaskStateTransaction(db),
  });
}
