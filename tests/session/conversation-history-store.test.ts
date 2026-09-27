import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';
import { SqliteConversationMetadataIndex } from '../../src/storage/conversation-metadata-index-repo.js';

it('creates an empty durable record once and recovers interrupted index initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'navigation-empty-create-'));
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
    const metadataIndex = new SqliteConversationMetadataIndex(db, 'local-default');
    const store = new FileConversationStore(root, { history, metadataIndex });
    await store.initialize();
    const conversation = {
      id: 'conv_new', plannerSessionId: 'conv_new', accountId: 'local-default', title: 'New',
      createdAt: 'now', updatedAt: 'now', archived: false, workspaceBinding: null,
    };
    const path = join(root, 'records', 'conv_new.json');
    const fail = vi.spyOn(history, 'importOnce').mockImplementationOnce(() => {
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.pending-history`)).toBe(false);
      throw new Error('interrupted empty index initialization');
    });
    await expect(store.writeConversation({ version: 3, conversation, turns: [] }))
      .rejects.toThrow('interrupted empty index initialization');
    fail.mockRestore();
    const reopened = new FileConversationStore(root, { history, metadataIndex });
    expect(await reopened.readMetadata('conv_new')).toEqual(conversation);
    expect(await reopened.readHistoryPage('conv_new')).toEqual({ turns: [], nextCursor: null });
    expect((await reopened.readConversation('conv_new'))?.conversation).toEqual(conversation);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('backfills rich-only legacy Turns around canonical anchors once without losing canonical answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'navigation-history-backfill-'));
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const legacy = new FileConversationStore(root);
    await legacy.initialize();
    const make = (id: string): ConversationTurn => ({
      id, conversationId: 'conv_a', userInput: id, finalAnswer: `answer ${id}`, status: 'completed',
    });
    await legacy.writeConversation({
      version: 3,
      conversation: {
        id: 'conv_a', plannerSessionId: 'conv_a', accountId: 'local-default', title: 'History',
        createdAt: 'now', updatedAt: 'now', archived: false, workspaceBinding: null,
      },
      turns: [make('anchor'), make('tui_only'), make('latest')],
    });
    const readLegacyHistory = vi.fn(async () => [
      make('rich_old'), { ...make('anchor'), finalAnswer: 'stale rich text' },
      make('rich_middle'), make('latest'),
    ]);
    const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
    const store = new FileConversationStore(root, { history, readLegacyHistory });
    const page = await store.readHistoryPage('conv_a', { limit: 2 });
    expect(page.turns.map(turn => turn.id)).toEqual(['rich_middle', 'latest']);
    const older = await store.readHistoryPage('conv_a', { cursor: page.nextCursor!, limit: 10 });
    expect(older.turns.map(turn => turn.id)).toEqual(['rich_old', 'anchor', 'tui_only']);
    expect(older.turns.find(turn => turn.id === 'anchor')?.finalAnswer).toBe('answer anchor');
    await writeFile(join(root, 'records', 'conv_a.json'), '{no aggregate reads after import');
    const reopened = new FileConversationStore(root, { history, readLegacyHistory });
    expect((await reopened.readHistoryPage('conv_a', { limit: 10 })).turns).toHaveLength(5);
    expect(readLegacyHistory).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reads old pages without parsing the aggregate and retains turns after rolling-record eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'navigation-history-'));
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const history = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'local-default', 'conversation');
    const metadataIndex = new SqliteConversationMetadataIndex(db, 'local-default');
    const store = new FileConversationStore(root, { history, metadataIndex });
    await store.initialize();
    const conversation = {
      id: 'conv_a', plannerSessionId: 'conv_a', accountId: 'local-default', title: 'History',
      createdAt: 'now', updatedAt: 'now', archived: false, workspaceBinding: null,
    };
    const turns = Array.from({ length: 30 }, (_, index): ConversationTurn => ({
      id: `turn_${index}`, conversationId: 'conv_a', userInput: `Query ${index}`,
      finalAnswer: `Answer ${index}`, status: 'completed',
    }));
    await store.writeConversation({ version: 3, conversation, turns });
    const first = await store.readHistoryPage('conv_a', { limit: 10 });
    await store.writeConversation({ version: 3, conversation, turns: turns.slice(-10) });
    await writeFile(join(root, 'records', 'conv_a.json'), '{do not parse');
    expect(await store.readMetadata('conv_a')).toEqual(conversation);
    const older = await store.readHistoryPage('conv_a', { cursor: first.nextCursor! });
    expect(older.turns.map(turn => turn.id)).toEqual(Array.from({ length: 10 }, (_, n) => `turn_${n + 10}`));
    expect(history.find('conv_a', 'turn_0')?.finalAnswer).toBe('Answer 0');
    const fail = vi.spyOn(history, 'upsert').mockImplementationOnce(() => {
      throw new Error('injected index write interruption');
    });
    await expect(store.writeConversation({
      version: 3, conversation, turns: [{ ...turns[0]!, id: 'turn_after_crash', finalAnswer: 'durable' }],
    })).rejects.toThrow('injected index write interruption');
    fail.mockRestore();
    const reopened = new FileConversationStore(root, { history, metadataIndex });
    expect((await reopened.readHistoryPage('conv_a', { limit: 1 })).turns[0]?.id).toBe('turn_after_crash');
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
