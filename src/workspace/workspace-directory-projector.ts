import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { ConversationMetadata } from '../session/conversation-store.js';
import type { ConversationActivityProjection } from './conversation-activity-projector.js';
import { WorkspaceConversationProjector } from './workspace-conversation-projector.js';
import type { WorkspaceDirectoryProjection } from './workspace-directory-projection.js';

export interface WorkspaceDirectoryProjectorDeps {
  readonly accountId: string;
  readonly projection: WorkspaceDirectoryProjection;
  readonly readMetadata: () => Promise<readonly ConversationMetadata[]>;
  readonly getActivities: (
    inputs: readonly { conversationId: string; updatedAt: string }[],
  ) => ReadonlyMap<string, ConversationActivityProjection>;
  readonly batchSize?: number;
  readonly yieldBatch?: () => Promise<void>;
  readonly onActivity?: (
    conversationId: string, activity: ConversationActivityProjection,
  ) => Promise<void> | void;
}

/** Rebuild and incremental projection, never a fallback on the navigation path. */
export class WorkspaceDirectoryProjector {
  private rebuildInFlight: Promise<void> | null = null;

  constructor(private readonly deps: WorkspaceDirectoryProjectorDeps) {}

  rebuild(): Promise<void> {
    if (this.rebuildInFlight) return this.rebuildInFlight;
    const operation = this.rebuildNow().finally(() => { this.rebuildInFlight = null; });
    this.rebuildInFlight = operation;
    return operation;
  }

  observeMetadata(metadata: ConversationMetadata): void {
    if (metadata.accountId !== this.deps.accountId) return;
    const summary = new WorkspaceConversationProjector().project(metadata);
    if (!summary) {
      this.observeDeletion(metadata.id);
      return;
    }
    const existing = this.deps.projection.find(metadata.id);
    this.deps.projection.upsert({ ...summary, activity: existing?.activity ?? summary.activity });
  }

  /** Called after an authoritative deletion in this projector's account. */
  observeDeletion(conversationId: string): void {
    this.deps.projection.remove(conversationId);
  }

  observeActivity(conversationId: string, activity: ConversationActivityProjection): void {
    this.deps.projection.updateActivity(conversationId, activity);
  }

  async drainChanges(): Promise<void> {
    if (this.deps.projection.state()?.status !== 'ready') return;
    const dirty = this.deps.projection.listDirty(50);
    const summaries = dirty.flatMap(item => {
      const summary = this.deps.projection.find(item.conversationId);
      return summary ? [summary] : [];
    });
    const activities = this.deps.getActivities(summaries.map(item => ({
      conversationId: item.conversationId, updatedAt: item.updatedAt,
    })));
    // Commit the observed batch synchronously. Awaiting publication between
    // writes would allow old observations to overwrite newer Planner facts.
    for (const item of dirty) {
      const activity = activities.get(item.conversationId);
      if (activity) this.observeActivity(item.conversationId, activity);
    }
    for (const item of dirty) {
      const activity = this.deps.projection.find(item.conversationId)?.activity;
      if (activity) await this.deps.onActivity?.(item.conversationId, activity);
      this.deps.projection.acknowledgeDirty(item);
    }
  }

  private async rebuildNow(): Promise<void> {
    const token = this.deps.projection.prepareRebuild();
    const source = (await this.deps.readMetadata())
      .filter(item => item.accountId === this.deps.accountId && item.workspaceBinding)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const fingerprint = createHash('sha256').update(JSON.stringify(source)).digest('hex');
    this.deps.projection.beginRebuild(fingerprint, token);
    const checkpoint = this.deps.projection.state()?.checkpoint ?? '';
    const pending = source.filter(item => item.id > checkpoint);
    const batchSize = Math.max(1, Math.min(this.deps.batchSize ?? 50, 100));
    for (let index = 0; index < pending.length; index += batchSize) {
      const batch = pending.slice(index, index + batchSize);
      const activities = this.deps.getActivities(batch.map(item => ({
        conversationId: item.id, updatedAt: item.updatedAt,
      })));
      // No await between observing facts and committing their batch/checkpoint.
      const projector = new WorkspaceConversationProjector({
        project: (id, updatedAt) => activities.get(id)
          ?? { state: 'idle', taskId: null, updatedAt, latestTaskCreatedAt: updatedAt },
      });
      this.deps.projection.writeBatch(batch.map(item => projector.project(item)!), batch.at(-1)!.id, token);
      await (this.deps.yieldBatch?.() ?? setImmediate());
    }
    while (!this.deps.projection.finishRebuild(token)) {
      await (this.deps.yieldBatch?.() ?? setImmediate());
    }
  }
}
