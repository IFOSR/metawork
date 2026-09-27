import { describe, expect, it } from 'vitest';
import type { ConversationStore } from '../../src/session/conversation-store.js';
import { updateConversationCatalog } from '../../src/session/conversation-catalog-mutation.js';

describe('Conversation catalog mutation queue', () => {
  it('propagates a write failure and allows the next writer to proceed', async () => {
    let writes = 0;
    const store = {
      readCatalog: async () => ({ version: 3, conversations: [] }),
      writeCatalog: async () => {
        if (++writes === 1) throw new Error('disk full');
      },
    } as unknown as ConversationStore;
    const first = updateConversationCatalog(store, value => value);
    const second = updateConversationCatalog(store, value => value);
    await expect(first).rejects.toThrow('disk full');
    await expect(second).resolves.toBeUndefined();
    expect(writes).toBe(2);
  });
});
