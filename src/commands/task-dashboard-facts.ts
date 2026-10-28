/**
 * Fact gathering for `/task dashboard`.
 *
 * Reads only durable facts: the Conversations of the current Workspace, their
 * Tasks, the canonical TaskView projection and the account-scoped execution
 * slots. It never derives a Task status; `buildTaskDashboard()` renders the
 * projection it receives.
 */

import type Database from 'better-sqlite3';
import type { CommandContext } from './catalog.js';
import type {
  TaskDashboardFacts,
  TaskDashboardTaskFact,
  TaskDashboardViewFact,
} from './task-dashboard-view.js';

export function readTaskDashboardFacts(
  context: CommandContext,
  now = new Date().toISOString(),
): TaskDashboardFacts {
  const currentConversationId = context.conversationId ?? null;
  const workspaceId = currentConversationId
    ? conversationWorkspaceId(context.db, currentConversationId)
    : null;
  const conversationIds = workspaceId !== null
    ? conversationsInWorkspace(context.db, workspaceId)
    : currentConversationId === null ? [] : [currentConversationId];
  const scoped = new Set(conversationIds);
  const titles = conversationTitles(context.db, conversationIds);

  const tasks = context.taskEngine.getTaskRepo().findAll()
    .filter(task => task.conversationId !== undefined && scoped.has(task.conversationId))
    .map(task => toTaskFact(context, task, titles));

  const slots = occupiedSlots(context.db);
  const localActive = slots.filter(slot => slot.conversationId !== null && scoped.has(slot.conversationId)).length;
  const limit = Math.max(1, context.config.orchestration.max_concurrent_tasks ?? 2);
  return {
    now,
    currentConversationId,
    capacity: {
      active: slots.length,
      limit,
      localActive,
      foreignActive: slots.length - localActive,
    },
    tasks,
  };
}

function toTaskFact(
  context: CommandContext,
  task: import('../core/types.js').Task,
  titles: ReadonlyMap<string, string>,
): TaskDashboardTaskFact {
  const conversationId = task.conversationId ?? null;
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    conversationId,
    conversationTitle: conversationId ? titles.get(conversationId) ?? null : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    view: taskViewFact(context, task.id),
  };
}

function taskViewFact(context: CommandContext, taskId: string): TaskDashboardViewFact | null {
  const view = context.taskControl?.taskView?.(taskId) ?? null;
  if (!view) return null;
  return {
    status: view.state.status,
    reasonCode: view.state.reason.code,
    reasonMessage: view.state.reason.message,
    phase: view.state.phase,
    pendingActionKinds: view.state.pendingActions.map(action => action.kind),
    cleanup: {
      state: view.state.cleanup.state,
      objects: view.state.cleanup.objects,
    },
  };
}

function conversationWorkspaceId(db: Database.Database, conversationId: string): string | null {
  const row = db.prepare(`
    SELECT workspace_id FROM workspace_directory_projection
    WHERE conversation_id = ? LIMIT 1
  `).get(conversationId) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

function conversationsInWorkspace(db: Database.Database, workspaceId: string): string[] {
  const rows = db.prepare(`
    SELECT conversation_id FROM workspace_directory_projection
    WHERE workspace_id = ?
  `).all(workspaceId) as Array<{ conversation_id: string }>;
  return rows.map(row => row.conversation_id);
}

/** Bounded display titles: the metadata projection is the only indexed source. */
function conversationTitles(db: Database.Database, conversationIds: readonly string[]): Map<string, string> {
  const titles = new Map<string, string>();
  if (conversationIds.length === 0) return titles;
  const statement = db.prepare(`
    SELECT metadata_json FROM conversation_metadata_projection WHERE conversation_id = ? LIMIT 1
  `);
  for (const conversationId of conversationIds) {
    const row = statement.get(conversationId) as { metadata_json: string } | undefined;
    if (!row) continue;
    try {
      const title = (JSON.parse(row.metadata_json) as { title?: unknown }).title;
      if (typeof title === 'string' && title.trim()) titles.set(conversationId, title.trim());
    } catch {
      // A corrupt metadata row is not a reason to fail the whole dashboard.
    }
  }
  return titles;
}

function occupiedSlots(db: Database.Database): Array<{ conversationId: string | null }> {
  const rows = db.prepare(`
    SELECT conversation_id FROM conversation_task_slots WHERE active_task_id IS NOT NULL
  `).all() as Array<{ conversation_id: string | null }>;
  return rows.map(row => ({ conversationId: row.conversation_id }));
}
