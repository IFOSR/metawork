import type Database from 'better-sqlite3';
import type { Task, TaskSnapshot, TaskStatus, Dependency } from '../core/types.js';
import { parseWorkspaceIntent } from '../core/workspace-execution.js';
import {
  isTaskStatus,
  normalizeTaskStateDetail,
  type TaskStateDetail,
} from '../task/task-state.js';
import type { TaskSearchIndexRepo } from './task-search-index-repo.js';

export type TimelineTaskRecord = Pick<
  Task,
  'id' | 'title' | 'status' | 'dependencies' | 'stateVersion' | 'stateDetail'
> & { readonly completedAt?: string | null; readonly archivedAt?: string | null; readonly retryOfTaskId?: string | null };

/**
 * Task metadata that may be updated outside the Task state transaction. The
 * lifecycle fields (`status`, `stateVersion`, `stateDetail`, `completedAt`,
 * `archivedAt`, `retryOfTaskId`) are deliberately excluded: only
 * `TaskLifecyclePort.applyTaskChange()` may write them.
 */
export type TaskMetadataChanges = Omit<
  Partial<Task>,
  | 'id'
  | 'status'
  | 'stateVersion'
  | 'stateDetail'
  | 'completedAt'
  | 'archivedAt'
  | 'retryOfTaskId'
  | 'createdAt'
  | 'updatedAt'
>;

interface TaskRow {
  id: string;
  title: string;
  goal: string;
  status: string;
  state_version: number;
  state_detail_json: string;
  completed_at: string | null;
  archived_at: string | null;
  retry_of_task_id: string | null;
  summary: string;
  snapshot_json: string;
  resources_json: string;
  artifacts_json: string | null;
  dependencies_json: string;
  priority_json: string | null;
  last_scheduling_reason: string | null;
  last_interruption_reason: string | null;
  interruption_count: number | null;
  created_at: string;
  updated_at: string;
  account_id: string;
  conversation_id: string;
  workspace_id: string;
  owner_planner_session_id: string;
  admitted_at: string;
  public_task_directory: string | null;
  public_delivery_baseline_json: string;
  public_project: number;
  start_service_after_publish: number;
  execution_mode: 'worktree' | 'in_place' | null;
  workspace_execution_source: string | null;
  workspace_delivery_policy: string | null;
  workspace_target_paths_json: string | null;
  workspace_intent_json: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    ...(row.public_task_directory ? { publicTaskDirectory: row.public_task_directory } : {}),
    publicDeliveryBaseline: JSON.parse(row.public_delivery_baseline_json ?? '{}'),
    publicProject: row.public_project === 1,
    startServiceAfterPublish: row.start_service_after_publish === 1,
    ...(row.execution_mode ? { executionMode: row.execution_mode } : {}),
    ...(row.workspace_execution_source
      ? { workspaceExecutionSource: row.workspace_execution_source as Task['workspaceExecutionSource'] }
      : {}),
    ...(row.workspace_delivery_policy
      ? { workspaceDeliveryPolicy: row.workspace_delivery_policy as Task['workspaceDeliveryPolicy'] }
      : {}),
    ...(row.workspace_target_paths_json
      ? { workspaceTargetPaths: safeJson(row.workspace_target_paths_json) as string[] }
      : {}),
    ...(row.workspace_intent_json
      ? { workspaceIntent: parseWorkspaceIntent(safeJson(row.workspace_intent_json)) }
      : {}),
    accountId: row.account_id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    ownerPlannerSessionId: row.owner_planner_session_id,
    admittedAt: row.admitted_at || row.created_at,
    title: row.title,
    goal: row.goal,
    status: row.status as TaskStatus,
    stateVersion: row.state_version,
    stateDetail: normalizeTaskStateDetail(safeJson(row.state_detail_json)),
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
    retryOfTaskId: row.retry_of_task_id,
    summary: row.summary,
    snapshots: JSON.parse(row.snapshot_json),
    resources: JSON.parse(row.resources_json),
    artifacts: JSON.parse(row.artifacts_json ?? '[]'),
    dependencies: JSON.parse(row.dependencies_json),
    prioritySignals: row.priority_json
      ? JSON.parse(row.priority_json)
      : { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    lastSchedulingReason: row.last_scheduling_reason ?? '',
    lastInterruptionReason: row.last_interruption_reason ?? '',
    interruptionCount: row.interruption_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export interface ApplyTaskStateInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly detail: TaskStateDetail;
  readonly completedAt: string | null;
  readonly at: string;
}

export class TaskRepo {
  constructor(
    private db: Database.Database,
    private readonly taskSearchIndexRepo?: TaskSearchIndexRepo,
  ) {}

  insert(task: Task): void {
    if (!isTaskStatus(task.status)) {
      throw new Error(`Task status must be one of the six Task states: ${task.status}`);
    }
    this.db.prepare(`
      INSERT INTO tasks (id, title, goal, status, state_version, state_detail_json, completed_at,
        archived_at, retry_of_task_id, summary, snapshot_json, resources_json, artifacts_json,
        dependencies_json, priority_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at,
        account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at,
        public_task_directory, public_delivery_baseline_json, start_service_after_publish,
        public_project, execution_mode, workspace_execution_source, workspace_delivery_policy,
        workspace_target_paths_json, workspace_intent_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.title, task.goal, task.status, task.stateVersion,
      JSON.stringify(task.stateDetail), task.completedAt, task.archivedAt, task.retryOfTaskId,
      task.summary,
      JSON.stringify(task.snapshots), JSON.stringify(task.resources),
      JSON.stringify(task.artifacts),
      JSON.stringify(task.dependencies), JSON.stringify(task.prioritySignals),
      task.lastSchedulingReason,
      task.lastInterruptionReason, task.interruptionCount, task.createdAt, task.updatedAt,
      task.accountId ?? 'legacy-account', task.conversationId ?? 'legacy-conversation',
      task.workspaceId ?? 'legacy-workspace', task.ownerPlannerSessionId ?? 'legacy-planner-session',
      task.admittedAt ?? task.createdAt,
      task.publicTaskDirectory ?? null,
      JSON.stringify(task.publicDeliveryBaseline ?? {}), task.startServiceAfterPublish ? 1 : 0, task.publicProject ? 1 : 0,
      task.executionMode ?? null,
      task.workspaceExecutionSource ?? '',
      task.workspaceDeliveryPolicy ?? '',
      JSON.stringify(task.workspaceTargetPaths ?? []),
      task.workspaceIntent ? JSON.stringify(task.workspaceIntent) : null,
    );
    this.taskSearchIndexRepo?.indexTask(task);
  }

  findById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  findByIds(accountId: string, ids: readonly string[]): Task[] {
    if (!ids.length) return [];
    if (ids.length > 100) throw new Error('history_task_limit');
    return (this.db.prepare(`SELECT * FROM tasks WHERE account_id = ?
      AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(accountId, ...ids) as TaskRow[]).map(rowToTask);
  }

  findTimelineByIds(accountId: string, ids: readonly string[]): TimelineTaskRecord[] {
    if (!ids.length) return [];
    if (ids.length > 100) throw new Error('history_task_limit');
    const rows = this.db.prepare(`
      SELECT id, title, status, dependencies_json, state_version, state_detail_json,
        completed_at, archived_at, retry_of_task_id FROM tasks
      WHERE account_id = ? AND id IN (${ids.map(() => '?').join(',')})
      ORDER BY id
    `).all(accountId, ...ids) as Array<Pick<TaskRow,
      'id' | 'title' | 'status' | 'dependencies_json' | 'state_version' | 'state_detail_json'
      | 'completed_at' | 'archived_at' | 'retry_of_task_id'>>;
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status as TaskStatus,
      dependencies: JSON.parse(row.dependencies_json) as Dependency[],
      stateVersion: row.state_version,
      stateDetail: normalizeTaskStateDetail(safeJson(row.state_detail_json)),
      completedAt: row.completed_at,
      archivedAt: row.archived_at,
      retryOfTaskId: row.retry_of_task_id,
    }));
  }

  findByStatus(status: TaskStatus): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC').all(status) as TaskRow[];
    return rows.map(rowToTask);
  }

  findByConversation(conversationId: string): Task[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE conversation_id = ? ORDER BY updated_at DESC, id',
    ).all(conversationId) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Tasks that still own a Conversation slot or are waiting for one. */
  findActive(): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE status IN ('queued', 'running', 'needs_action') ORDER BY updated_at DESC`
    ).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  findAll(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Metadata update. It cannot change a lifecycle field; those only move through
   * `applyTaskState()`, which the Task Domain port calls inside the state
   * transaction.
   */
  update(id: string, changes: TaskMetadataChanges): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (changes.title !== undefined) { sets.push('title = ?'); values.push(changes.title); }
    if (changes.goal !== undefined) { sets.push('goal = ?'); values.push(changes.goal); }
    if (changes.summary !== undefined) { sets.push('summary = ?'); values.push(changes.summary); }
    if (changes.snapshots !== undefined) { sets.push('snapshot_json = ?'); values.push(JSON.stringify(changes.snapshots)); }
    if (changes.resources !== undefined) { sets.push('resources_json = ?'); values.push(JSON.stringify(changes.resources)); }
    if (changes.artifacts !== undefined) { sets.push('artifacts_json = ?'); values.push(JSON.stringify(changes.artifacts)); }
    if (changes.dependencies !== undefined) { sets.push('dependencies_json = ?'); values.push(JSON.stringify(changes.dependencies)); }
    if (changes.prioritySignals !== undefined) { sets.push('priority_json = ?'); values.push(JSON.stringify(changes.prioritySignals)); }
    if (changes.lastSchedulingReason !== undefined) { sets.push('last_scheduling_reason = ?'); values.push(changes.lastSchedulingReason); }
    if (changes.lastInterruptionReason !== undefined) { sets.push('last_interruption_reason = ?'); values.push(changes.lastInterruptionReason); }
    if (changes.interruptionCount !== undefined) { sets.push('interruption_count = ?'); values.push(changes.interruptionCount); }
    if (changes.publicDeliveryBaseline !== undefined) { sets.push('public_delivery_baseline_json = ?'); values.push(JSON.stringify(changes.publicDeliveryBaseline)); }
    if (changes.workspaceExecutionSource !== undefined) { sets.push('workspace_execution_source = ?'); values.push(changes.workspaceExecutionSource ?? ''); }
    if (changes.workspaceDeliveryPolicy !== undefined) { sets.push('workspace_delivery_policy = ?'); values.push(changes.workspaceDeliveryPolicy ?? ''); }
    if (changes.workspaceTargetPaths !== undefined) { sets.push('workspace_target_paths_json = ?'); values.push(JSON.stringify(changes.workspaceTargetPaths)); }
    if (changes.workspaceIntent !== undefined) { sets.push('workspace_intent_json = ?'); values.push(changes.workspaceIntent ? JSON.stringify(changes.workspaceIntent) : null); }
    if (changes.startServiceAfterPublish !== undefined) { sets.push('start_service_after_publish = ?'); values.push(changes.startServiceAfterPublish ? 1 : 0); }
    if (changes.publicProject !== undefined) { sets.push('public_project = ?'); values.push(changes.publicProject ? 1 : 0); }

    if (sets.length === 1) return;
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const updatedTask = this.findById(id);
    if (updatedTask) {
      this.taskSearchIndexRepo?.indexTask(updatedTask);
    }
  }

  /**
   * Conditional Task state write. Returns `null` when the expected version or
   * source status no longer holds, so a stale operation rolls back instead of
   * overwriting a newer conclusion.
   */
  applyTaskState(input: ApplyTaskStateInput): Task | null {
    const completedAt = input.completedAt;
    const applied = this.db.prepare(`
      UPDATE tasks SET status = ?, state_version = state_version + 1, state_detail_json = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND state_version = ? AND status = ?
    `).run(
      input.to, JSON.stringify(input.detail), completedAt, input.at,
      input.taskId, input.expectedVersion, input.from,
    );
    if (applied.changes !== 1) return null;
    const updatedTask = this.findById(input.taskId);
    if (updatedTask) this.taskSearchIndexRepo?.indexTask(updatedTask);
    return updatedTask;
  }

  /**
   * Archiving is an attribute of a finished Task, never a status. It is not a
   * state change, so it does not bump `state_version`.
   */
  setArchivedAt(id: string, archivedAt: string | null): void {
    this.db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archivedAt, new Date().toISOString(), id);
  }

  appendSnapshot(id: string, snapshot: TaskSnapshot): void {
    const task = this.findById(id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    const snapshots = [...task.snapshots, snapshot];
    this.update(id, { snapshots });
  }
}
