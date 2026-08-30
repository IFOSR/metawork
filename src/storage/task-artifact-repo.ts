import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolvePreviewKind, type ArtifactProjection } from '../delivery/user-artifact-types.js';

export type TaskArtifactStatus = 'published' | 'unavailable';

export interface TaskArtifactRecord {
  artifactId: string;
  accountId: string;
  taskId: string;
  generationId: string | null;
  subtaskId: string | null;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  /** 仅由后端使用，不进入任何 Web projection。 */
  publishedPath: string;
  mediaType: string;
  previewKind: ArtifactProjection['previewKind'];
  contentHash: string;
  byteLength: number;
  status: TaskArtifactStatus;
  createdAt: string;
  updatedAt: string;
}

interface TaskArtifactRow {
  artifact_id: string;
  account_id: string;
  task_id: string;
  generation_id: string | null;
  subtask_id: string | null;
  publication_id: string | null;
  display_name: string;
  relative_path: string;
  published_path: string;
  media_type: string;
  preview_kind: string;
  content_hash: string;
  byte_length: number;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: TaskArtifactRow): TaskArtifactRecord {
  return {
    artifactId: row.artifact_id,
    accountId: row.account_id,
    taskId: row.task_id,
    generationId: row.generation_id,
    subtaskId: row.subtask_id,
    publicationId: row.publication_id,
    displayName: row.display_name,
    relativePath: row.relative_path,
    publishedPath: row.published_path,
    mediaType: row.media_type,
    previewKind: row.preview_kind as ArtifactProjection['previewKind'],
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    status: row.status as TaskArtifactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertTaskArtifactInput {
  accountId: string;
  taskId: string;
  generationId?: string | null;
  subtaskId?: string | null;
  publicationId?: string | null;
  displayName: string;
  relativePath: string;
  publishedPath: string;
  mediaType: string;
  previewKind: ArtifactProjection['previewKind'];
  contentHash: string;
  byteLength: number;
  status?: TaskArtifactStatus;
  now: string;
}

/**
 * Durable facts for user-visible artifacts. `published_path` stays
 * backend-only; every Web consumer must go through `toProjection`.
 */
export class TaskArtifactRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: InsertTaskArtifactInput): TaskArtifactRecord {
    const record: TaskArtifactRecord = {
      artifactId: `artifact_${randomUUID()}`,
      accountId: input.accountId,
      taskId: input.taskId,
      generationId: input.generationId ?? null,
      subtaskId: input.subtaskId ?? null,
      publicationId: input.publicationId ?? null,
      displayName: input.displayName,
      relativePath: input.relativePath,
      publishedPath: input.publishedPath,
      mediaType: input.mediaType,
      previewKind: input.previewKind,
      contentHash: input.contentHash,
      byteLength: input.byteLength,
      status: input.status ?? 'published',
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.db.prepare(`
      INSERT INTO task_artifacts (
        artifact_id, account_id, task_id, generation_id, subtask_id,
        publication_id, display_name, relative_path, published_path,
        media_type, preview_kind, content_hash, byte_length, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.artifactId,
      record.accountId,
      record.taskId,
      record.generationId,
      record.subtaskId,
      record.publicationId,
      record.displayName,
      record.relativePath,
      record.publishedPath,
      record.mediaType,
      record.previewKind,
      record.contentHash,
      record.byteLength,
      record.status,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  findById(artifactId: string): TaskArtifactRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM task_artifacts WHERE artifact_id = ?',
    ).get(artifactId) as TaskArtifactRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByTaskAndRelativePath(
    taskId: string,
    relativePath: string,
    contentHash: string,
  ): TaskArtifactRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM task_artifacts
      WHERE task_id = ? AND relative_path = ? AND content_hash = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(taskId, relativePath, contentHash) as TaskArtifactRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByTask(taskId: string): TaskArtifactRecord[] {
    return (this.db.prepare(`
      SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at, artifact_id
    `).all(taskId) as TaskArtifactRow[]).map(rowToRecord);
  }

  listByPublication(publicationId: string): TaskArtifactRecord[] {
    return (this.db.prepare(`
      SELECT * FROM task_artifacts WHERE publication_id = ? ORDER BY created_at, artifact_id
    `).all(publicationId) as TaskArtifactRow[]).map(rowToRecord);
  }

  markUnavailable(artifactId: string, now: string): void {
    this.db.prepare(`
      UPDATE task_artifacts SET status = 'unavailable', updated_at = ?
      WHERE artifact_id = ?
    `).run(now, artifactId);
  }

  /** 同名文件被新内容覆盖后，旧记录标记为不可用，不再进入用户投影。 */
  markSupersededExcept(
    taskId: string,
    relativePath: string,
    keepArtifactId: string,
    now: string,
  ): void {
    this.db.prepare(`
      UPDATE task_artifacts SET status = 'unavailable', updated_at = ?
      WHERE task_id = ? AND relative_path = ?
        AND artifact_id <> ? AND status = 'published'
    `).run(now, taskId, relativePath, keepArtifactId);
  }

  toProjection(record: TaskArtifactRecord): ArtifactProjection {
    const previewKind = record.status === 'unavailable'
      ? 'unsupported'
      : resolvePreviewKind(record.previewKind, record.mediaType);
    return {
      artifactId: record.artifactId,
      taskId: record.taskId,
      publicationId: record.publicationId,
      displayName: record.displayName,
      relativePath: record.relativePath,
      mediaType: record.mediaType,
      previewKind,
      previewable: record.status === 'published'
        && ['markdown', 'text', 'code', 'image'].includes(previewKind),
      byteLength: record.byteLength,
      contentHash: record.contentHash,
      publishedAt: record.createdAt,
    };
  }
}

export function hashContent(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
