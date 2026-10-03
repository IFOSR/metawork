import type { ConversationTaskSummary } from './conversation-activity-types.js';
import type { ConversationActivityTask } from './conversation-activity-source.js';

/** Rebuildable Task presentation only; lifecycle and phase remain Task Domain owned. */
export interface ConversationActivityProjectionStore {
  nextDirty(): { task: ConversationActivityTask; version: number } | null;
  read(taskId: string): ConversationTaskSummary | null;
  commit(taskId: string, version: number, value: ConversationTaskSummary): void;
}

export class ConversationActivityProjector {
  constructor(private readonly store: ConversationActivityProjectionStore,
    private readonly project: (task: ConversationActivityTask) => ConversationTaskSummary) {}
  maintain(): boolean {
    const item = this.store.nextDirty();
    if (!item) return false;
    this.store.commit(item.task.id, item.version, this.project(item.task));
    return true;
  }
}
