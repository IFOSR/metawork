import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ClientActionReferences } from '../../src/gateway/client-action-reference.js';
import { SqliteClientActionReferences, CLIENT_ACTION_REFERENCE_SCHEMA_SQL } from '../../src/storage/client-action-reference-repo.js';

describe('signed Feishu action references', () => {
  it('binds account, operator, destination and exact generation across restart, rejecting tamper and expiry', () => {
    const db = new Database(':memory:'); db.exec(CLIENT_ACTION_REFERENCE_SCHEMA_SQL);
    try {
      let now = Date.now();
      const store = new SqliteClientActionReferences(db);
      const actions = new ClientActionReferences(store, () => now);
      const actor = { accountId: 'account', principalId: 'feishu:tenant:operator', chatId: 'chat', threadId: 'thread' };
      const token = actions.issue({ ...actor, conversationId: 'old-conversation',
        command: { kind: 'cancel_task', taskId: 'old-task', expectedExecutionGeneration: 'generation-one' } }, 1000);
      const reopened = new ClientActionReferences(new SqliteClientActionReferences(db), () => now);
      expect(reopened.resolve(token, actor)).toMatchObject({ conversationId: 'old-conversation',
        command: { taskId: 'old-task', expectedExecutionGeneration: 'generation-one' } });
      for (const field of ['accountId', 'principalId', 'chatId', 'threadId']) {
        expect(() => reopened.resolve(token, { ...actor, [field]: 'other' })).toThrow('forbidden_scope');
      }
      const last = token.at(-1) === 'a' ? 'b' : 'a';
      expect(() => reopened.resolve(token.slice(0, -1) + last, actor)).toThrow('invalid_action_reference');
      now += 1000;
      expect(() => reopened.resolve(token, actor)).toThrow('request_expired');
    } finally { db.close(); }
  });
});
