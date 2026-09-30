import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { recordConversationInputTitle } from '../../src/session/conversation-title.js';

describe('Conversation input title', () => {
  it('names the Conversation before any terminal Turn and preserves its first ordinary input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-title-'));
    try {
      const store = new FileConversationStore(root);
      await store.initialize();
      const metadata = {
        id: 'conv_1', plannerSessionId: 'conv_1', accountId: 'local-default',
        title: 'New conversation', createdAt: '2026-09-30T00:00:00Z',
        updatedAt: '2026-09-30T00:00:00Z', archived: false, workspaceBinding: null,
      };
      await store.writeConversation({ version: 3, conversation: metadata, turns: [] });
      await store.writeCatalog({ version: 3, conversations: [metadata] });
      await recordConversationInputTitle(store, 'conv_1', '/status');
      expect((await store.readMetadata('conv_1'))?.title).toBe('New conversation');
      await recordConversationInputTitle(store, 'conv_1', '  Analyze\n the project  ');
      await recordConversationInputTitle(store, 'conv_1', 'Second request');
      expect((await store.readMetadata('conv_1'))?.title).toBe('Analyze the project');
      expect((await store.readConversation('conv_1'))?.turns).toEqual([]);
      expect((await store.readCatalog()).conversations[0]?.title).toBe('Analyze the project');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
