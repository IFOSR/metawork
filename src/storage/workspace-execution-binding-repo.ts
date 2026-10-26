import type Database from 'better-sqlite3';
import type { ExecutionMode } from '../execution/execution-context.js';
import type {
  WorkspaceDeliveryPolicy,
  WorkspaceExecutionSource,
  WorkspaceIntent,
} from '../core/workspace-execution.js';

export interface WorkspaceExecutionBinding {
  taskId: string;
  generationId: string;
  workspaceId: string;
  canonicalPath: string;
  executionMode: ExecutionMode;
  authorizedWorkingDirectory: string;
  /** Which admission fact authorized the mode (planner/fallback/kernel safety). */
  modeSource?: WorkspaceExecutionSource | null;
  deliveryPolicy?: WorkspaceDeliveryPolicy | null;
  /** Planner-owned semantics fixed at admission (schema 9 plans only). */
  workspaceIntent?: WorkspaceIntent | null;
  /** Workspace-relative paths this generation is authorized to touch. */
  targetPaths?: string[];
  /** Set only after the internal execution directory was retired. */
  cleanedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BindingRow {
  task_id: string;
  generation_id: string;
  workspace_id: string;
  canonical_path: string;
  execution_mode: ExecutionMode;
  authorized_working_directory: string;
  mode_source: string | null;
  delivery_policy: string | null;
  workspace_intent_json: string | null;
  targeted_paths_json: string | null;
  cleaned_at: string | null;
  created_at: string;
  updated_at: string;
}

function bindingFromRow(row: BindingRow): WorkspaceExecutionBinding {
  return {
    taskId: row.task_id,
    generationId: row.generation_id,
    workspaceId: row.workspace_id,
    canonicalPath: row.canonical_path,
    executionMode: row.execution_mode,
    authorizedWorkingDirectory: row.authorized_working_directory,
    modeSource: (row.mode_source || null) as WorkspaceExecutionSource | null,
    deliveryPolicy: (row.delivery_policy || null) as WorkspaceDeliveryPolicy | null,
    workspaceIntent: parseIntent(row.workspace_intent_json),
    targetPaths: parsePaths(row.targeted_paths_json),
    cleanedAt: row.cleaned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseIntent(raw: string | null): WorkspaceIntent | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkspaceIntent;
  } catch {
    return null;
  }
}

function parsePaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Durable, immutable-per-generation execution facts. Recovery reads the binding
 * instead of re-deriving a mode or a working directory from the environment.
 * Only `cleaned_at` is mutable: it records that the internal Worktree execution
 * directory was retired after the generation became terminal.
 */
export class WorkspaceExecutionBindingRepo {
  constructor(private readonly db: Database.Database) {}

  find(taskId: string, generationId: string): WorkspaceExecutionBinding | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_execution_bindings
      WHERE task_id = ? AND generation_id = ?
    `).get(taskId, generationId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  /** Latest binding of a Task, used to inherit its immutable mode on replan. */
  findLatestForTask(taskId: string): WorkspaceExecutionBinding | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_execution_bindings
      WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(taskId) as BindingRow | undefined;
    return row ? bindingFromRow(row) : null;
  }

  listByTask(taskId: string): WorkspaceExecutionBinding[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_execution_bindings WHERE task_id = ? ORDER BY created_at, generation_id
    `).all(taskId) as BindingRow[];
    return rows.map(bindingFromRow);
  }

  /** Returns the existing binding when one is already durable for this generation. */
  upsert(binding: WorkspaceExecutionBinding): WorkspaceExecutionBinding {
    const existing = this.find(binding.taskId, binding.generationId);
    if (existing) return existing;
    this.db.prepare(`
      INSERT INTO workspace_execution_bindings (
        task_id, generation_id, workspace_id, canonical_path, execution_mode,
        authorized_working_directory, mode_source, delivery_policy, workspace_intent_json,
        targeted_paths_json, cleaned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.taskId,
      binding.generationId,
      binding.workspaceId,
      binding.canonicalPath,
      binding.executionMode,
      binding.authorizedWorkingDirectory,
      binding.modeSource ?? '',
      binding.deliveryPolicy ?? '',
      binding.workspaceIntent ? JSON.stringify(binding.workspaceIntent) : null,
      JSON.stringify(binding.targetPaths ?? []),
      binding.cleanedAt ?? null,
      binding.createdAt,
      binding.updatedAt,
    );
    return this.find(binding.taskId, binding.generationId) ?? binding;
  }

  /** Retired Worktree cleanup queue. New bindings never enter this queue. */
  listTasksWithUncleanedWorktrees(limit = 50): string[] {
    void limit;
    return [];
  }

  markCleaned(taskId: string, generationId: string, cleanedAt: string): void {
    this.db.prepare(`
      UPDATE workspace_execution_bindings
      SET cleaned_at = ?, updated_at = ?
      WHERE task_id = ? AND generation_id = ? AND cleaned_at IS NULL
    `).run(cleanedAt, cleanedAt, taskId, generationId);
  }
}
