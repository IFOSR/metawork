import type { WebSessionMetadata } from './api/session-types';

export interface ConversationDirectoryChange {
  workspaceId: string;
  conversationId: string;
  removed?: boolean;
  changes?: Partial<WebSessionMetadata>;
}

/** Only reconciles events arriving during a client request; never owns activity. */
export class NavigationDirectoryChanges {
  sequence = 0;
  private floor = 0;
  private readonly changes: Array<{ sequence: number; event: ConversationDirectoryChange }> = [];

  observe(event: ConversationDirectoryChange): void {
    this.changes.push({ sequence: ++this.sequence, event });
    if (this.changes.length > 512) this.floor = this.changes.shift()!.sequence;
  }

  merge(rows: WebSessionMetadata[], workspaceId: string, query: string, since: number): WebSessionMetadata[] {
    if (since < this.floor) throw new Error('directory_changed_retry');
    const byId = new Map(rows.filter(row => row.workspaceId === workspaceId).map(row => [row.id, row]));
    for (const { sequence, event } of this.changes) {
      if (sequence <= since || event.workspaceId !== workspaceId) continue;
      if (event.removed) {
        byId.delete(event.conversationId);
        continue;
      }
      const existing = byId.get(event.conversationId);
      if (existing) byId.set(event.conversationId, { ...existing, ...event.changes });
      else if (event.changes?.id && event.changes.title && event.changes.createdAt) {
        byId.set(event.conversationId, { ...event.changes, workspaceId } as WebSessionMetadata);
      }
    }
    const search = query.trim().toLocaleLowerCase();
    return [...byId.values()].filter(row => !row.archived && (!search || row.title.toLocaleLowerCase().includes(search)))
      .sort((a, b) => (b.latestTaskCreatedAt ?? b.createdAt).localeCompare(
        a.latestTaskCreatedAt ?? a.createdAt,
      )
        || a.id.localeCompare(b.id));
  }
}

export function shouldActivateConversation(selected: string, active: string | null, pendingTarget: string | null): boolean {
  return selected !== active || pendingTarget !== null;
}
