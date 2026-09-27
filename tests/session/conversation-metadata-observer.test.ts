import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';

it('observes committed metadata only, including changes made outside the directory facade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-observer-'));
  try {
    const onMetadataCommitted = vi.fn();
    const store = new FileConversationStore(root, { onMetadataCommitted });
    await store.initialize();
    const record = {
      version: 3 as const, turns: [],
      conversation: {
        id: 'conv_test', plannerSessionId: 'conv_test', accountId: 'local-default',
        title: 'Title', createdAt: 'now', updatedAt: 'now', archived: false,
        workspaceBinding: null,
      },
    };
    await store.writeConversation(record);
    expect(onMetadataCommitted).toHaveBeenCalledWith(record.conversation);
    expect(await store.readConversation(record.conversation.id)).toEqual(record);
    onMetadataCommitted.mockClear();
    await expect(store.writeConversation({ ...record, version: 0 } as never)).rejects.toThrow();
    expect(onMetadataCommitted).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
