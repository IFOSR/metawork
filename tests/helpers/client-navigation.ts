import type { ClientNavigationKey, ClientNavigationSelection, ClientNavigationStore } from '../../src/session/client-navigation-store.js';
export class MemoryClientNavigation implements ClientNavigationStore {
  private readonly rows = new Map<string, ClientNavigationSelection>();
  private key(value: ClientNavigationKey): string {
    return JSON.stringify([value.accountId, value.principalId, value.platform, value.channelId, value.threadId ?? '']);
  }
  read(key: ClientNavigationKey) { return this.rows.get(this.key(key)) ?? null; }
  write(value: ClientNavigationSelection) { this.rows.set(this.key(value), value); }
}
