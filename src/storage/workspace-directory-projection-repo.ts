import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { WorkspaceConversationSummary } from '../workspace/workspace-conversation-projector.js';
import type { ConversationActivityProjection } from '../workspace/conversation-activity-projector.js';
import {
  WORKSPACE_DIRECTORY_PROJECTION_VERSION,
  type DirectoryProjectionState,
  type DirectoryInvalidation,
  type WorkspaceDirectoryProjection,
} from '../workspace/workspace-directory-projection.js';
import type { WorkspaceConversationPage, WorkspaceConversationPageRequest } from '../workspace/workspace-directory-service.js';

const rank = { blocked: 5, executing: 4, waiting: 3, planning: 2, idle: 1 };

/** Fixed-size progress only. Per-Conversation guards/candidates live in indexed tables. */
interface RebuildCheckpoint {
  version: 2;
  token: string;
  rebuildId: string;
  cursor: string;
  sourceConfirmed: boolean;
}

interface DirectoryCursor {
  version: number;
  accountId: string;
  workspaceId: string;
  revision: number;
  query: string;
  archived: boolean;
  rank: number;
  updatedAt: string;
  id: string;
}

export class SqliteWorkspaceDirectoryProjectionRepo implements WorkspaceDirectoryProjection {
  constructor(private readonly db: Database.Database, private readonly accountId: string) {}

  listDirty(limit: number): DirectoryInvalidation[] {
    return this.db.prepare(`
      SELECT conversation_id AS conversationId, revision FROM workspace_directory_dirty
      WHERE account_id = ? ORDER BY conversation_id LIMIT ?
    `).all(this.accountId, Math.min(100, Math.max(1, Math.floor(limit)))) as DirectoryInvalidation[];
  }

  acknowledgeDirty(item: DirectoryInvalidation): void {
    this.db.prepare(`
      DELETE FROM workspace_directory_dirty
      WHERE account_id = ? AND conversation_id = ? AND revision = ?
    `).run(this.accountId, item.conversationId, item.revision);
  }

  state(): DirectoryProjectionState | null {
    const row = this.db.prepare(`
      SELECT status, source_fingerprint AS sourceFingerprint,
        CASE WHEN json_valid(checkpoint) THEN json_extract(checkpoint, '$.cursor') ELSE '' END AS checkpoint
      FROM workspace_directory_rebuilds WHERE account_id = ? AND projection_version = ?
    `).get(this.accountId, WORKSPACE_DIRECTORY_PROJECTION_VERSION) as DirectoryProjectionState | undefined;
    return row ?? null;
  }

  prepareRebuild(): string {
    return this.db.transaction(() => {
      const stored = this.readRebuild();
      const previous = stored && this.decodeCheckpoint(stored.checkpoint);
      const resume = stored?.status === 'building' && previous !== null;
      // Keep the candidate/observation generation on restart, but fence the old writer.
      const progress = resume && previous ? previous : this.newCheckpoint();
      progress.token = randomUUID();
      progress.sourceConfirmed = false;
      this.saveRebuild('building', resume ? stored!.sourceFingerprint : '', progress);
      if (!resume) {
        this.db.prepare('DELETE FROM workspace_directory_rebuild_candidates WHERE account_id = ?')
          .run(this.accountId);
        this.captureCandidates(progress.rebuildId);
      }
      // Planner activity is ephemeral, so even checkpointed rows need fresh facts after restart.
      this.db.prepare(`
        INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
        SELECT account_id, conversation_id, 1 FROM workspace_directory_projection WHERE account_id = ?
        ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1
      `).run(this.accountId);
      return progress.token;
    })();
  }

  beginRebuild(sourceFingerprint: string, token: string): void {
    this.db.transaction(() => {
      const { stored, progress } = this.requireRebuild(token);
      if (stored.sourceFingerprint !== sourceFingerprint) {
        // A changed source must revisit rows imported before an interruption too.
        progress.cursor = '';
        this.captureCandidates(progress.rebuildId);
      }
      progress.sourceConfirmed = true;
      this.saveRebuild('building', sourceFingerprint, progress);
    })();
  }

  writeBatch(items: readonly WorkspaceConversationSummary[], checkpoint: string, token: string): void {
    this.db.transaction(() => {
      const { stored, progress } = this.requireRebuild(token, true);
      for (const item of items) {
        if (!this.isProtected(item.conversationId, progress.rebuildId)) this.writeSummary(item, true);
        this.discardCandidate(item.conversationId, progress.rebuildId);
      }
      progress.cursor = checkpoint;
      this.saveRebuild('building', stored.sourceFingerprint, progress);
    })();
  }

  finishRebuild(token: string): boolean {
    return this.db.transaction(() => {
      const { stored, progress } = this.requireRebuild(token, true);
      const batch = this.db.prepare(`
        SELECT conversation_id FROM workspace_directory_rebuild_candidates
        WHERE account_id = ? AND rebuild_id = ? ORDER BY conversation_id LIMIT 100
      `).all(this.accountId, progress.rebuildId) as { conversation_id: string }[];
      for (const { conversation_id: id } of batch) {
        if (!this.isProtected(id, progress.rebuildId)) {
          this.rememberRemoval(id, progress.rebuildId);
          this.deleteRow(id);
        }
        this.discardCandidate(id, progress.rebuildId);
      }
      const ready = !this.db.prepare(`
        SELECT 1 FROM workspace_directory_rebuild_candidates
        WHERE account_id = ? AND rebuild_id = ? LIMIT 1
      `).get(this.accountId, progress.rebuildId);
      this.saveRebuild(ready ? 'ready' : 'building', stored.sourceFingerprint, progress);
      return ready;
    })();
  }

  find(conversationId: string): WorkspaceConversationSummary | null {
    const row = this.db.prepare(`
      SELECT summary_json FROM workspace_directory_projection WHERE account_id = ? AND conversation_id = ?
    `).get(this.accountId, conversationId) as { summary_json: string } | undefined;
    return row ? JSON.parse(row.summary_json) as WorkspaceConversationSummary : null;
  }

  upsert(item: WorkspaceConversationSummary): void {
    this.db.transaction(() => {
      this.protectObservation(item.conversationId, true);
      this.writeSummary(item);
    })();
  }

  remove(conversationId: string): void {
    this.db.transaction(() => {
      const stored = this.readRebuild();
      const progress = stored && this.decodeCheckpoint(stored.checkpoint);
      this.rememberRemoval(conversationId, progress?.rebuildId ?? '');
      if (progress && stored?.status === 'building') this.discardCandidate(conversationId, progress.rebuildId);
      this.deleteRow(conversationId);
    })();
  }

  private writeSummary(item: WorkspaceConversationSummary, freshActivity = false): void {
    const previous = this.find(item.conversationId);
    // Binding authorization belongs to the Conversation domain. This read
    // model also reflects its permitted pre-first-Query empty rebindings.
    const metadata = previous && previous.updatedAt > item.updatedAt ? previous : item;
    const activity = !freshActivity && previous && previous.activity.updatedAt > item.activity.updatedAt
      ? previous.activity : item.activity;
    const merged = { ...metadata, activity };
    if (JSON.stringify(previous) === JSON.stringify(merged)) return;
    this.db.prepare(`
      INSERT INTO workspace_directory_projection (
        account_id, workspace_id, conversation_id, archived, activity_rank,
        updated_at, title_search, summary_json, projection_version
      ) VALUES (@accountId, @workspaceId, @conversationId, @archived, @rank,
        @updatedAt, @title, @json, @version)
      ON CONFLICT(account_id, conversation_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        archived = excluded.archived, activity_rank = excluded.activity_rank,
        updated_at = excluded.updated_at, title_search = excluded.title_search,
        summary_json = excluded.summary_json, projection_version = excluded.projection_version
    `).run({
      accountId: this.accountId, workspaceId: merged.workspaceId, conversationId: merged.conversationId,
      archived: Number(merged.archived), rank: rank[merged.activity.state], updatedAt: merged.updatedAt,
      title: merged.title.toLocaleLowerCase(), json: JSON.stringify(merged),
      version: WORKSPACE_DIRECTORY_PROJECTION_VERSION,
    });
    this.db.prepare(`
      INSERT INTO workspace_directory_revisions (account_id, workspace_id, revision) VALUES (?, ?, 1)
      ON CONFLICT(account_id, workspace_id) DO UPDATE SET revision = revision + 1
    `).run(this.accountId, merged.workspaceId);
    if (previous && previous.workspaceId !== merged.workspaceId) {
      this.db.prepare(`
        UPDATE workspace_directory_revisions SET revision = revision + 1
        WHERE account_id = ? AND workspace_id = ?
      `).run(this.accountId, previous.workspaceId);
    }
  }

  updateActivity(conversationId: string, activity: ConversationActivityProjection): void {
    // The fact timestamp is not an observation sequence: a completed Planner
    // can reveal an older blocked Task. Serialized fresh observations replace it.
    this.db.transaction(() => {
      const previous = this.find(conversationId);
      if (!previous) return;
      this.protectObservation(conversationId, false);
      if (JSON.stringify(previous.activity) === JSON.stringify(activity)) return;
      this.db.prepare(`
        UPDATE workspace_directory_projection SET activity_rank = ?, summary_json = ?
        WHERE account_id = ? AND conversation_id = ?
      `).run(rank[activity.state], JSON.stringify({ ...previous, activity }), this.accountId, conversationId);
      this.db.prepare(`
        UPDATE workspace_directory_revisions SET revision = revision + 1
        WHERE account_id = ? AND workspace_id = ?
      `).run(this.accountId, previous.workspaceId);
    })();
  }

  page(workspaceId: string, request: WorkspaceConversationPageRequest): WorkspaceConversationPage {
    // Navigation never deserializes the rebuild candidate/tombstone sets.
    const readiness = this.db.prepare(`
      SELECT status FROM workspace_directory_rebuilds WHERE account_id = ? AND projection_version = ?
    `).get(this.accountId, WORKSPACE_DIRECTORY_PROJECTION_VERSION) as { status: string } | undefined;
    if (readiness?.status !== 'ready') throw new Error('directory_rebuilding');
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_page_limit');
    const boundedLimit = Math.min(limit, 100);
    const revision = (this.db.prepare(`
      SELECT revision FROM workspace_directory_revisions WHERE account_id = ? AND workspace_id = ?
    `).get(this.accountId, workspaceId) as { revision: number } | undefined)?.revision ?? 0;
    const query = request.query?.trim().toLocaleLowerCase() ?? '';
    const archived = request.includeArchived === true;
    const cursor = this.decodeCursor(request.cursor);
    if (cursor && (cursor.accountId !== this.accountId || cursor.workspaceId !== workspaceId
      || cursor.query !== query || cursor.archived !== archived)) throw new Error('invalid_cursor');
    if (cursor && cursor.revision !== revision) throw new Error('stale_directory_cursor');
    // The common path uses equality on archived so the index supplies the order.
    const rows = this.db.prepare(`
      SELECT summary_json FROM workspace_directory_projection
      WHERE account_id = @accountId AND workspace_id = @workspaceId
        ${archived ? '' : 'AND archived = @archived'}
        AND (@query = '' OR instr(title_search, @query) > 0)
        AND (@rank IS NULL OR activity_rank < @rank
          OR (activity_rank = @rank AND updated_at < @updatedAt)
          OR (activity_rank = @rank AND updated_at = @updatedAt AND conversation_id > @id))
      ORDER BY activity_rank DESC, updated_at DESC, conversation_id ASC LIMIT @limit
    `).all({
      accountId: this.accountId, workspaceId, archived: 0, query,
      rank: cursor?.rank ?? null, updatedAt: cursor?.updatedAt ?? '', id: cursor?.id ?? '',
      limit: boundedLimit + 1,
    }) as { summary_json: string }[];
    const items = rows.slice(0, boundedLimit).map(row => JSON.parse(row.summary_json) as WorkspaceConversationSummary);
    const last = items.at(-1);
    const next: DirectoryCursor | null = rows.length > boundedLimit && last ? {
      version: WORKSPACE_DIRECTORY_PROJECTION_VERSION, accountId: this.accountId,
      workspaceId, revision, query, archived, rank: rank[last.activity.state],
      updatedAt: last.updatedAt, id: last.conversationId,
    } : null;
    return {
      items, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
      projectionVersion: WORKSPACE_DIRECTORY_PROJECTION_VERSION,
    };
  }

  private readRebuild(): DirectoryProjectionState | null {
    return (this.db.prepare(`
      SELECT status, source_fingerprint AS sourceFingerprint, checkpoint
      FROM workspace_directory_rebuilds WHERE account_id = ? AND projection_version = ?
    `).get(this.accountId, WORKSPACE_DIRECTORY_PROJECTION_VERSION) as DirectoryProjectionState | undefined) ?? null;
  }

  private decodeCheckpoint(value: string): RebuildCheckpoint | null {
    // A cursor without candidate provenance cannot be safely resumed; prepareRebuild restarts it.
    if (!value.startsWith('{')) return null;
    const progress = JSON.parse(value) as RebuildCheckpoint;
    if (progress.version !== 2 || typeof progress.token !== 'string' || typeof progress.rebuildId !== 'string'
      || typeof progress.cursor !== 'string' || typeof progress.sourceConfirmed !== 'boolean') {
      throw new Error('invalid_directory_rebuild_checkpoint');
    }
    return progress;
  }

  private captureCandidates(rebuildId: string): void {
    this.db.prepare('DELETE FROM workspace_directory_rebuild_candidates WHERE account_id = ? AND rebuild_id = ?')
      .run(this.accountId, rebuildId);
    this.db.prepare(`
      INSERT INTO workspace_directory_rebuild_candidates (account_id, rebuild_id, conversation_id)
      SELECT p.account_id, ?, p.conversation_id FROM workspace_directory_projection p
      WHERE p.account_id = ? AND NOT EXISTS (
        SELECT 1 FROM workspace_directory_observations o
        WHERE o.account_id = p.account_id AND o.conversation_id = p.conversation_id
          AND (o.removed = 1 OR o.rebuild_id = ?)
      )
    `).run(rebuildId, this.accountId, rebuildId);
  }

  private newCheckpoint(): RebuildCheckpoint {
    return {
      version: 2, token: randomUUID(), rebuildId: randomUUID(), cursor: '', sourceConfirmed: false,
    };
  }

  private saveRebuild(
    status: DirectoryProjectionState['status'], sourceFingerprint: string, progress: RebuildCheckpoint,
  ): void {
    this.db.prepare(`
      INSERT INTO workspace_directory_rebuilds
        (account_id, projection_version, status, source_fingerprint, checkpoint)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET projection_version = excluded.projection_version,
        status = excluded.status, source_fingerprint = excluded.source_fingerprint, checkpoint = excluded.checkpoint
    `).run(this.accountId, WORKSPACE_DIRECTORY_PROJECTION_VERSION, status, sourceFingerprint, JSON.stringify(progress));
  }

  private requireRebuild(token: string, sourceConfirmed = false) {
    const stored = this.readRebuild();
    const progress = stored && this.decodeCheckpoint(stored.checkpoint);
    if (!stored || stored.status !== 'building') throw new Error('directory_not_rebuilding');
    if (!progress || progress.token !== token) throw new Error('stale_directory_rebuild');
    if (sourceConfirmed && !progress.sourceConfirmed) throw new Error('directory_source_not_read');
    return { stored, progress };
  }

  private protectObservation(conversationId: string, restore: boolean): void {
    const stored = this.readRebuild();
    const progress = stored && this.decodeCheckpoint(stored.checkpoint);
    if (stored?.status === 'building' && progress) {
      this.db.prepare(`
        INSERT INTO workspace_directory_observations (account_id, conversation_id, rebuild_id, removed)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(account_id, conversation_id) DO UPDATE SET
          rebuild_id = excluded.rebuild_id, removed = CASE WHEN ? THEN 0 ELSE removed END
      `).run(this.accountId, conversationId, progress.rebuildId, Number(restore));
      this.discardCandidate(conversationId, progress.rebuildId);
    } else if (restore) {
      this.db.prepare('DELETE FROM workspace_directory_observations WHERE account_id = ? AND conversation_id = ?')
        .run(this.accountId, conversationId);
    }
  }

  private isProtected(conversationId: string, rebuildId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM workspace_directory_observations
      WHERE account_id = ? AND conversation_id = ? AND (removed = 1 OR rebuild_id = ?)
    `).get(this.accountId, conversationId, rebuildId));
  }

  private discardCandidate(conversationId: string, rebuildId: string): void {
    this.db.prepare(`
      DELETE FROM workspace_directory_rebuild_candidates
      WHERE account_id = ? AND rebuild_id = ? AND conversation_id = ?
    `).run(this.accountId, rebuildId, conversationId);
  }

  private rememberRemoval(conversationId: string, rebuildId: string): void {
    this.db.prepare(`
      INSERT INTO workspace_directory_observations (account_id, conversation_id, rebuild_id, removed)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(account_id, conversation_id) DO UPDATE SET rebuild_id = excluded.rebuild_id, removed = 1
    `).run(this.accountId, conversationId, rebuildId);
  }

  private deleteRow(conversationId: string): void {
    const previous = this.find(conversationId);
    if (!previous) return;
    this.db.prepare('DELETE FROM workspace_directory_projection WHERE account_id = ? AND conversation_id = ?')
      .run(this.accountId, conversationId);
    this.db.prepare(`
      UPDATE workspace_directory_revisions SET revision = revision + 1 WHERE account_id = ? AND workspace_id = ?
    `).run(this.accountId, previous.workspaceId);
  }

  private decodeCursor(value: string | undefined): DirectoryCursor | null {
    if (!value) return null;
    try {
      if (value.length > 4096) throw new Error();
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as DirectoryCursor;
      if (cursor.version !== WORKSPACE_DIRECTORY_PROJECTION_VERSION
        || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0
        || !Number.isInteger(cursor.rank) || cursor.rank < 1 || cursor.rank > 5
        || typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string'
        || typeof cursor.query !== 'string' || typeof cursor.archived !== 'boolean') throw new Error();
      return cursor;
    } catch {
      throw new Error('invalid_cursor');
    }
  }
}
