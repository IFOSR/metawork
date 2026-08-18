import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BindingConversationResolver } from '../../src/gateway/conversation-resolver.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('gateway account isolation', () => {
  it('denies cross-account conversation attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'isolation-'));
    roots.push(root);
    const bindings = new ConversationBindingRepository(join(root, 'bindings.json'));
    await bindings.initialize();

    const resolver = new BindingConversationResolver({
      bindings,
      createId: () => 'conv_new',
      verifyOwnership: async (accountId, conversationId) => (
        accountId === 'acct-one' && conversationId === 'conv_1'
      ),
    });

    const owned = await resolver.resolve('acct-one', { mode: 'attach', conversationId: 'conv_1' });
    const crossAccount = await resolver.resolve('acct-two', { mode: 'attach', conversationId: 'conv_1' });

    expect(owned).toEqual({ status: 'resolved', conversationId: 'conv_1' });
    expect(crossAccount.status).toBe('denied');
  });

  it('rejects event journal path traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'isolation-journal-'));
    roots.push(root);
    const journal = new FileEventJournal(join(root, 'journal'));

    await expect(journal.append({
      protocolVersion: 1,
      eventId: 'e1',
      sequence: 0,
      accountId: '../evil',
      conversationId: 'conv_1',
      requestId: null,
      turnId: null,
      kind: 'turn_started',
      payload: {},
      occurredAt: '2026-08-18T00:00:00.000Z',
    })).rejects.toThrow();

    await expect(journal.append({
      protocolVersion: 1,
      eventId: 'e2',
      sequence: 0,
      accountId: 'local-default',
      conversationId: '../evil',
      requestId: null,
      turnId: null,
      kind: 'turn_started',
      payload: {},
      occurredAt: '2026-08-18T00:00:00.000Z',
    })).rejects.toThrow();
  });
});
