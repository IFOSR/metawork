import type Database from 'better-sqlite3';
import type {
  WorkspaceCleanupResult,
  WorkspacePersistenceRecord,
  WorkspaceRepositoryPort,
} from '../execution/repositories.js';

interface Row {
  id: string; task_id: string; generation_id: string; subtask_id: string;
  workspace_kind: 'git'; root_uri: string; baseline_json: string;
  managed_repository_uri: string | null; managed_branch: string | null; head_commit: string | null;
  current_checkpoint_id: string | null; status: WorkspacePersistenceRecord['status']; cleanup_after: string | null;
  created_at: string; updated_at: string;
}

function fromRow(row: Row): WorkspacePersistenceRecord {
  return {
    id: row.id, taskId: row.task_id, generationId: row.generation_id, subtaskId: row.subtask_id,
    kind: row.workspace_kind, rootUri: row.root_uri, baseline: JSON.parse(row.baseline_json) as Record<string, unknown>,
    managedRepositoryUri: row.managed_repository_uri, managedBranch: row.managed_branch,
    headCommit: row.head_commit, currentCheckpointId: row.current_checkpoint_id,
    status: row.status, cleanupAfter: row.cleanup_after, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class SqliteWorkspaceRepository implements WorkspaceRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  upsert(record: WorkspacePersistenceRecord): WorkspacePersistenceRecord {
    this.db.prepare(`
      INSERT INTO workspace_records (
        id, task_id, generation_id, subtask_id, workspace_kind, root_uri,
        baseline_json, managed_repository_uri, managed_branch, head_commit,
        current_checkpoint_id, status, cleanup_after, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, generation_id, subtask_id) DO UPDATE SET
        root_uri = excluded.root_uri, baseline_json = excluded.baseline_json,
        managed_repository_uri = excluded.managed_repository_uri,
        managed_branch = excluded.managed_branch, head_commit = excluded.head_commit,
        current_checkpoint_id = excluded.current_checkpoint_id,
        status = excluded.status, cleanup_after = excluded.cleanup_after,
        updated_at = excluded.updated_at
    `).run(
      record.id, record.taskId, record.generationId, record.subtaskId, record.kind,
      record.rootUri, JSON.stringify(record.baseline), record.managedRepositoryUri,
      record.managedBranch, record.headCommit, record.currentCheckpointId,
      record.status, record.cleanupAfter, record.createdAt, record.updatedAt,
    );
    return this.find(record.id) ?? fromRow(this.db.prepare(`
      SELECT * FROM workspace_records WHERE task_id = ? AND generation_id = ? AND subtask_id = ?
    `).get(record.taskId, record.generationId, record.subtaskId) as Row);
  }

  find(id: string): WorkspacePersistenceRecord | null {
    const row = this.db.prepare('SELECT * FROM workspace_records WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  findByIdentity(taskId: string, generationId: string, subtaskId: string): WorkspacePersistenceRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM workspace_records WHERE task_id = ? AND generation_id = ? AND subtask_id = ?
    `).get(taskId, generationId, subtaskId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  scheduleTaskCleanup(
    taskId: string,
    status: 'archived' | 'cancelled',
    cleanupAfter: string,
    updatedAt: string,
  ): number {
    return this.db.prepare(`
      UPDATE workspace_records
      SET status = ?, cleanup_after = COALESCE(cleanup_after, ?), updated_at = ?
      WHERE task_id = ? AND status <> 'archived'
    `).run(status, cleanupAfter, updatedAt, taskId).changes;
  }

  listCleanupDue(now: string): WorkspacePersistenceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM workspace_records
      WHERE status IN ('archived', 'cancelled')
        AND cleanup_after IS NOT NULL AND cleanup_after <= ?
      ORDER BY cleanup_after, id
    `).all(now) as Row[]).map(fromRow);
  }

  deleteWorkspace(workspaceId: string): WorkspaceCleanupResult | null {
    const transaction = this.db.transaction((): WorkspaceCleanupResult | null => {
      const record = this.find(workspaceId);
      if (!record || !['archived', 'cancelled'].includes(record.status)) return null;
      const objectRows = this.db.prepare(`
        SELECT object.content_hash AS hash, object.object_uri AS uri, COUNT(*) AS links
        FROM workspace_checkpoint_objects link
        JOIN workspace_objects object ON object.content_hash = link.content_hash
        JOIN workspace_checkpoints checkpoint ON checkpoint.id = link.checkpoint_id
        WHERE checkpoint.workspace_id = ?
        GROUP BY object.content_hash, object.object_uri
      `).all(workspaceId) as Array<{ hash: string; uri: string; links: number }>;
      const checkpointIds = this.db.prepare(`
        SELECT id FROM workspace_checkpoints WHERE workspace_id = ?
      `).all(workspaceId) as Array<{ id: string }>;
      const deleteLinks = this.db.prepare('DELETE FROM workspace_checkpoint_objects WHERE checkpoint_id = ?');
      for (const checkpoint of checkpointIds) deleteLinks.run(checkpoint.id);
      this.db.prepare('DELETE FROM workspace_checkpoints WHERE workspace_id = ?').run(workspaceId);
      const decrement = this.db.prepare(`
        UPDATE workspace_objects
        SET reference_count = MAX(reference_count - ?, 0)
        WHERE content_hash = ?
      `);
      for (const object of objectRows) decrement.run(object.links, object.hash);
      this.db.prepare('DELETE FROM workspace_records WHERE id = ?').run(workspaceId);

      const unreferencedObjectUris: string[] = [];
      for (const object of objectRows) {
        const current = this.db.prepare(`
          SELECT reference_count FROM workspace_objects WHERE content_hash = ?
        `).get(object.hash) as { reference_count: number } | undefined;
        if (current?.reference_count !== 0) continue;
        this.db.prepare('DELETE FROM workspace_objects WHERE content_hash = ? AND reference_count = 0').run(object.hash);
        unreferencedObjectUris.push(object.uri);
      }

      const unreferencedManagedRepositoryUris: string[] = [];
      if (record.managedRepositoryUri) {
        const remaining = this.db.prepare(`
          SELECT COUNT(*) AS count FROM workspace_records WHERE managed_repository_uri = ?
        `).get(record.managedRepositoryUri) as { count: number };
        if (remaining.count === 0) unreferencedManagedRepositoryUris.push(record.managedRepositoryUri);
      }
      return {
        workspaceId,
        rootUri: record.rootUri,
        unreferencedObjectUris,
        unreferencedManagedRepositoryUris,
      };
    });
    return transaction.immediate();
  }

  recordCheckpoint(input: Parameters<WorkspaceRepositoryPort['recordCheckpoint']>[0]): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO workspace_checkpoints (
          id, workspace_id, attempt_id, reason, manifest_uri, manifest_hash,
          manifest_size, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id, input.workspaceId, input.attemptId, input.reason, input.manifestUri,
        input.manifestHash, input.manifestSize, input.createdAt,
      );
      const upsertObject = this.db.prepare(`
        INSERT INTO workspace_objects (
          content_hash, object_uri, size_bytes, media_type, reference_count, created_at, last_referenced_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
          object_uri = excluded.object_uri, size_bytes = excluded.size_bytes,
          last_referenced_at = excluded.last_referenced_at
      `);
      const linkObject = this.db.prepare(`
        INSERT OR IGNORE INTO workspace_checkpoint_objects (checkpoint_id, content_hash) VALUES (?, ?)
      `);
      const incrementObject = this.db.prepare(`
        UPDATE workspace_objects SET reference_count = reference_count + 1, last_referenced_at = ?
        WHERE content_hash = ?
      `);
      for (const object of input.objects ?? []) {
        upsertObject.run(object.hash, object.uri, object.size, object.mediaType ?? null, input.createdAt, input.createdAt);
        if (linkObject.run(input.id, object.hash).changes === 1) {
          incrementObject.run(input.createdAt, object.hash);
        }
      }
      this.db.prepare(`
        UPDATE workspace_records SET current_checkpoint_id = ?, updated_at = ? WHERE id = ?
      `).run(input.id, input.createdAt, input.workspaceId);
    });
    transaction.immediate();
  }
}
