import { createHash, randomUUID } from 'node:crypto';

export interface ClientNotification {
  id: string;
  workspaceId: string;
  conversationId: string;
  turnId?: string;
  taskId: string;
  kind: 'completed' | 'failed' | 'approval';
}
export interface ClientNotificationPage {
  events: ClientNotification[];
  cursor: string;
  reset: boolean;
}

/** Bounded presentation hints while a client is running; never a task/recovery authority. */
export class ClientNotificationFeed {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly entries: Array<{ sequence: number; accountId: string; value: ClientNotification }> = [];
  private readonly seen = new Set<string>();

  publish(accountId: string, value: Omit<ClientNotification, 'id'>, version: string): void {
    const id = createHash('sha256').update(JSON.stringify([accountId, value.taskId, value.kind, version])).digest('hex');
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.entries.push({ sequence: ++this.sequence, accountId, value: { ...value, id } });
    while (this.entries.length > 512) this.seen.delete(this.entries.shift()!.value.id);
  }

  read(accountId: string, cursor: string | null): ClientNotificationPage {
    const [epoch, raw] = cursor?.split(':') ?? [];
    const sequence = Number(raw);
    const reset = epoch !== this.epoch || !Number.isSafeInteger(sequence) || sequence < 0
      || sequence > this.sequence || sequence < (this.entries[0]?.sequence ?? 1) - 1;
    // A new client starts at the current head: historical work must not produce a notification storm.
    if (reset) return { events: [], cursor: `${this.epoch}:${this.sequence}`, reset: true };
    const page = this.entries.filter(entry => entry.sequence > sequence).slice(0, 64);
    return {
      events: page.filter(entry => entry.accountId === accountId).map(entry => entry.value),
      cursor: `${this.epoch}:${page.at(-1)?.sequence ?? sequence}`, reset: false,
    };
  }
}
