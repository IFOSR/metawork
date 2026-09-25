// Reconciles half-cancelled task state left behind by historical races:
// orphaned dispatch items, conversation slots held by terminal tasks, and
// zombie schedule entries. Runs at server start, periodically, and on demand
// through `metawork maintenance reconcile-tasks`.
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { createDatabase } from '../storage/database.js';
import { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';
import { KernelDispatchItemRepo } from '../storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../storage/workspace-publication-repo.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { WorkUnitClaimService } from './work-unit-claim-service.js';
import {
  TaskResidueReader,
  type TaskResidueCategory,
} from './task-residue-reader.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';

export interface TaskStateReconcilerReport {
  ok: boolean;
  lines: string[];
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
    dispatchItemRepo: new KernelDispatchItemRepo(db),
    publicationRepo: new WorkspacePublicationRepo(db),
    workUnitClaimService: new WorkUnitClaimService(new WorkUnitRepo(db)),
  });
  const lines: string[] = [];

  // 1. Dispatch items for terminal tasks that never reached a live backend.
  //    `cancelling`, `uncertain` and backend-backed items are left alone: they
  //    are resolved along the durable Kernel path, never by a SQL shortcut.
  const closedDispatchItems = db.prepare(`
    UPDATE kernel_dispatch_items AS item
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
        WHERE tasks.id = item.task_id AND tasks.status IN ('cancelled', 'done', 'failed', 'archived')
      )
  `).run(now(), now(), now(), now()).changes;
  if (closedDispatchItems > 0) {
    lines.push(`closed ${closedDispatchItems} orphaned dispatch item(s) for terminal tasks`);
  }

  // 2. Conversation slots held by terminal tasks (blocked tasks keep their
  //    slot on purpose — the Planner asks the user how to proceed).
  const staleSlots = db.prepare(`
    SELECT conversation_id, active_task_id FROM conversation_task_slots
    WHERE active_task_id IS NOT NULL AND state IN ('occupied', 'releasing')
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = conversation_task_slots.active_task_id
          AND tasks.status IN ('cancelled', 'done', 'failed', 'archived')
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
    const released = scheduler.releaseSlot(slot.conversation_id, slot.active_task_id, now());
    releasedSlots += 1;
    if (released) lines.push(`released stale conversation slot in ${slot.conversation_id}`);
  }
  if (releasedSlots > 0) {
    lines.push(`released ${releasedSlots} conversation slot(s) held by terminal tasks`);
  }

  // 3. Schedule entries still marked running/queued for terminal tasks.
  const closedScheduleEntries = db.prepare(`
    UPDATE task_schedule_entries AS entry
    SET state = 'terminal', last_scheduled_at = COALESCE(last_scheduled_at, ?)
    WHERE entry.state IN ('queued', 'eligible', 'reserved', 'running')
      AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = entry.task_id AND tasks.status IN ('cancelled', 'done', 'failed', 'archived')
      )
  `).run(now()).changes;
  if (closedScheduleEntries > 0) {
    lines.push(`closed ${closedScheduleEntries} schedule entr(ies) for terminal tasks`);
  }

  const ok = true;
  if (lines.length === 0) lines.push('task state is consistent; nothing to reconcile');
  return {
    ok,
    lines,
    closedDispatchItems,
    releasedSlots,
    retainedSlots: retainedSlotResidue.length,
    retainedSlotResidue,
    closedScheduleEntries,
  };
}
