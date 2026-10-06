import type { ClientNotification, ClientNotificationPage } from '../../../src/gateway/client-notification-feed.js';
import { identifier } from './security.js';

/** One bounded account feed, independent of whichever Conversation is visible. */
export class DesktopNotifications {
  private cursor: string | null = null;
  private origin: string | null = null;
  private polling = false;
  private stopped = false;
  private readonly seen = new Set<string>();
  constructor(private readonly deps: {
    fetch: typeof fetch;
    show: (event: ClientNotification) => void;
    unavailable: () => void;
  }) {}
  attach(origin: string): void {
    if (origin !== this.origin) { this.origin = origin; this.cursor = null; }
    this.stopped = false;
  }
  stop(): void { this.stopped = true; this.origin = null; this.cursor = null; }
  async poll(): Promise<void> {
    if (!this.origin || this.stopped || this.polling) return;
    this.polling = true;
    const origin = this.origin;
    try {
      const url = `${origin}/api/client/notifications${this.cursor ? `?cursor=${encodeURIComponent(this.cursor)}` : ''}`;
      const response = await this.deps.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Feed unavailable');
      const page = await response.json() as ClientNotificationPage;
      if (this.origin !== origin || this.stopped) return;
      if (typeof page.cursor !== 'string' || page.cursor.length > 128 || !Array.isArray(page.events) || page.events.length > 64) return;
      for (const event of page.events) {
        if (![event.id, event.workspaceId, event.conversationId, event.taskId].every(identifier)
          || (event.turnId !== undefined && !identifier(event.turnId))
          || !['approval', 'completed', 'failed'].includes(event.kind) || this.seen.has(event.id)) continue;
        this.seen.add(event.id);
        if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
        this.deps.show(event);
      }
      this.cursor = page.cursor;
    } catch { if (!this.stopped && this.origin === origin) this.deps.unavailable(); }
    finally { this.polling = false; }
  }
}
