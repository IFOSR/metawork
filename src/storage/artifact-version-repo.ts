import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ArtifactVersion {
  artifactVersionId: string;
  accountId: string;
  workspaceId: string;
  sourceTaskId: string | null;
  sourceAttemptId: string | null;
  relativePath: string;
  contentHash: string;
  byteLength: number;
  /** Content-addressed object location owned by the Runtime, never a user Workspace path. */
  objectUri: string;
  gitCommit?:string|null;
  gitRelativePath?:string|null;
  mediaType: string;
  createdAt: string;
}

interface ArtifactVersionRow {
  artifact_version_id: string;
  account_id: string;
  workspace_id: string;
  source_task_id: string | null;
  source_attempt_id: string | null;
  relative_path: string;
  content_hash: string;
  byte_length: number;
  object_uri: string;
  git_commit:string|null;
  git_relative_path:string|null;
  media_type: string;
  created_at: string;
}

function versionFromRow(row: ArtifactVersionRow): ArtifactVersion {
  return {
    artifactVersionId: row.artifact_version_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sourceTaskId: row.source_task_id,
    sourceAttemptId: row.source_attempt_id,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    byteLength: row.byte_length,
    objectUri: row.object_uri,
    gitCommit:row.git_commit,gitRelativePath:row.git_relative_path,
    mediaType: row.media_type,
    createdAt: row.created_at,
  };
}

/**
 * Fixed content for handoffs, cross-Task inputs, downloads and audit. Ordinary
 * round-by-round delivery stays a live reference and never writes a version.
 */
export class ArtifactVersionRepo {
  constructor(private readonly db: Database.Database) {}

  record(input: Omit<ArtifactVersion, 'artifactVersionId' | 'createdAt'> & {
    artifactVersionId?: string;
    createdAt?: string;
  }): ArtifactVersion {
    const existing = this.findByContent(input.workspaceId, input.relativePath, input.contentHash);
    if (existing) return existing;
    const artifactVersionId = input.artifactVersionId ?? `artifact_version_${randomUUID()}`;
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO artifact_versions (
        artifact_version_id, account_id, workspace_id, source_task_id, source_attempt_id,
        relative_path, content_hash, byte_length, object_uri, media_type, created_at,git_commit,git_relative_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactVersionId,
      input.accountId,
      input.workspaceId,
      input.sourceTaskId,
      input.sourceAttemptId,
      input.relativePath,
      input.contentHash,
      input.byteLength,
      input.objectUri,
      input.mediaType,
      createdAt,input.gitCommit??null,input.gitRelativePath??null,
    );
    return this.find(artifactVersionId) ?? {
      ...input,
      artifactVersionId,
      createdAt,
    };
  }

  find(artifactVersionId: string): ArtifactVersion | null {
    const row = this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_version_id = ?')
      .get(artifactVersionId) as ArtifactVersionRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  findByContent(workspaceId: string, relativePath: string, contentHash: string): ArtifactVersion | null {
    const row = this.db.prepare(`
      SELECT * FROM artifact_versions
      WHERE workspace_id = ? AND relative_path = ? AND content_hash = ?
    `).get(workspaceId, relativePath, contentHash) as ArtifactVersionRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  listByTask(taskId: string): ArtifactVersion[] {
    const rows = this.db.prepare('SELECT * FROM artifact_versions WHERE source_task_id = ? ORDER BY created_at DESC')
      .all(taskId) as ArtifactVersionRow[];
    return rows.map(versionFromRow);
  }
}
