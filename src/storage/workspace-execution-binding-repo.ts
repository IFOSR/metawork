import type Database from 'better-sqlite3';
import type { ExecutionMode } from '../execution/execution-context.js';

export interface WorkspaceExecutionBinding {
  taskId: string;
  generationId: string;
  workspaceId: string;
  canonicalPath: string;
  executionMode: ExecutionMode;
  authorizedWorkingDirectory: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Durable, immutable-per-generation execution facts. Recovery reads the binding
 * instead of re-deriving a mode or a working directory from the environment.
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

  /** Returns the existing binding when one is already durable for this generation. */
  upsert(binding: WorkspaceExecutionBinding): WorkspaceExecutionBinding {
    const existing = this.find(binding.taskId, binding.generationId);
    if (existing) return existing;
    this.db.prepare(`
      INSERT INTO workspace_execution_bindings (
        task_id, generation_id, workspace_id, canonical_path, execution_mode,
        authorized_working_directory, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.taskId,
      binding.generationId,
      binding.workspaceId,
      binding.canonicalPath,
      binding.executionMode,
      binding.authorizedWorkingDirectory,
      binding.createdAt,
      binding.updatedAt,
    );
    return this.find(binding.taskId, binding.generationId) ?? binding;
  }
}
