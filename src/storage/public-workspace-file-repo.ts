import type Database from 'better-sqlite3';

export interface PublicWorkspaceFile {
  accountId: string;
  taskId: string;
  relativePath: string;
  generationId: string | null;
  subtaskId: string | null;
  publicationId: string | null;
  publishedPath: string;
  contentHash: string;
  updatedAt: string;
}

/** Published code facts are separate from Planner-declared downloadable artifacts. */
export class PublicWorkspaceFileRepo {
  constructor(private readonly db: Database.Database) {}

  record(file: PublicWorkspaceFile): void {
    this.db.prepare(`INSERT INTO public_workspace_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, task_id, relative_path) DO UPDATE SET
      generation_id=excluded.generation_id, subtask_id=excluded.subtask_id,
      publication_id=excluded.publication_id, published_path=excluded.published_path,
      content_hash=excluded.content_hash, updated_at=excluded.updated_at`).run(
      file.accountId, file.taskId, file.relativePath, file.generationId, file.subtaskId,
      file.publicationId, file.publishedPath, file.contentHash, file.updatedAt);
  }

  list(accountId: string, taskId: string): Array<PublicWorkspaceFile & { status: 'published' }> {
    const rows = this.db.prepare(`SELECT * FROM public_workspace_files
      WHERE account_id=? AND task_id=? ORDER BY relative_path`).all(accountId, taskId) as Array<{
      account_id: string; task_id: string; relative_path: string; generation_id: string | null;
      subtask_id: string | null; publication_id: string | null; published_path: string;
      content_hash: string; updated_at: string;
    }>;
    return rows.map(row => ({ accountId: row.account_id, taskId: row.task_id,
      relativePath: row.relative_path, generationId: row.generation_id,
      subtaskId: row.subtask_id, publicationId: row.publication_id,
      publishedPath: row.published_path, contentHash: row.content_hash,
      updatedAt: row.updated_at, status: 'published' }));
  }

  remove(accountId: string, taskId: string, relativePath: string): void {
    this.db.prepare('DELETE FROM public_workspace_files WHERE account_id=? AND task_id=? AND relative_path=?')
      .run(accountId, taskId, relativePath);
  }

  invalidatePath(accountId: string, publishedPath: string): void {
    this.db.prepare('DELETE FROM public_workspace_files WHERE account_id=? AND published_path=?')
      .run(accountId, publishedPath);
  }
}
