import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { SqliteConversationTurnStore } from '../../src/storage/conversation-turn-repo.js';
import { readTaskOriginInput } from '../../src/storage/task-origin-input.js';

describe('Task original request', () => {
  it('retains exact user constraints after restart and rejects another account or Conversation', () => {
    const db = new Database(':memory:');
    try {
      initializeDatabaseSchema(db);
      db.prepare("INSERT INTO tasks (id, title, goal, account_id, conversation_id, created_at, updated_at) VALUES ('task', 'Compare', 'Internal plan goal', 'account', 'conv', 'now', 'now')").run();
      db.prepare("INSERT INTO query_usage_contexts VALUES ('query', 'account', 'web', 'key', 'digest', 'conv', 'req', 'turn', NULL, 'now')").run();
      db.prepare("INSERT INTO query_task_links VALUES ('query', 'task', 'decision', 'authorized_application', 'now')").run();
      const identity = { accountId: 'account', conversationId: 'conv', turnId: 'turn' };
      new SqliteConversationTurnStore(db).accept({ ...identity, userInput: '比较两个标记，最终不超过 120 字。', requestKey: 'key',
        event: { ...identity, eventId: 'event', requestId: 'req', protocolVersion: 2, sequence: 0,
          kind: 'turn_started', occurredAt: 'now', payload: {} } });
      expect(readTaskOriginInput(db, { ...identity, taskId: 'task' })).toEqual({
        queryId: 'query', userInput: '比较两个标记，最终不超过 120 字。',
      });
      expect(readTaskOriginInput(db, { ...identity, accountId: 'foreign', taskId: 'task' })).toBeNull();
      expect(readTaskOriginInput(db, { ...identity, conversationId: 'other', taskId: 'task' })).toBeNull();
    } finally { db.close(); }
  });
});
