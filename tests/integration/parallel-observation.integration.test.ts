import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { ConversationObservationService, type ConversationObservationFrame } from '../../src/gateway/conversation-observation.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';

describe('parallel durable progress observation', () => {
  it.each([3, 8, 20])('browses %i independently progressing Conversations without sharing cursors or stopping work', async count => {
    const root = await mkdtemp(join(tmpdir(), 'mw-parallel-observation-'));
    const db = new Database(':memory:'); runMigrations(db);
    const subscriptions = new GatewaySubscriptions();
    const runtime = createAccountEventJournal({ db, root, accountId: 'account', onError: error => { throw error; } });
    const service = new ConversationObservationService({ model: runtime.readModel, subscriptions,
      authorize: async account => account === 'account', sourceSequence: (account, id) => runtime.readModel.head(account, id)?.journalSequence ?? 0,
      onError: error => { throw error; } });
    const conversations = Array.from({ length: count }, (_, n) => `conversation_${n}`);
    const append = async (conversationId: string, revision: number) => runtime.journal.append({
      protocolVersion: 2, accountId: 'account', conversationId, turnId: `turn_${conversationId}`,
      requestId: `request_${conversationId}`, eventId: `${conversationId}_${revision}`, sequence: 0,
      kind: 'trace_delta', occurredAt: new Date().toISOString(), payload: { taskId: `task_${conversationId}`, status: 'running',
        events: [{ id: `${conversationId}_${revision}`, sequence: revision, kind: 'query_received', actor: 'user', summary: `progress ${conversationId}` }] },
    });
    try {
      await Promise.all(conversations.map(id => append(id, 1)));
      for (let round = 2; round <= 5; round++) {
        const selected = conversations[(round - 2) % count]!;
        const frames: ConversationObservationFrame[] = [];
        const handle = await service.open({ accountId: 'account', conversationId: selected, observationId: String(round),
          send: frame => { frames.push(frame); return true; } });
        await Promise.all(conversations.map(id => append(id, round)));
        await handle.refresh(); handle.close();
        expect(frames.some(frame => frame.kind === 'patch')).toBe(true);
        expect(frames.every(frame => frame.conversationId === selected && Buffer.byteLength(JSON.stringify(frame)) <= 65536)).toBe(true);
      }
      for (const conversationId of conversations) {
        const page = await service.page('account', conversationId);
        expect(page.turns).toHaveLength(1);
        expect(page.turns[0]).toMatchObject({ taskId: `task_${conversationId}`, status: 'running', lastSequence: 5 });
      }
      expect(new SqliteEventJournalSegmentIndex(db).headSequence('account', conversations.at(-1)!)).toBe(5);
    } finally { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('pages 30,000 safe trace events through the index within the byte budget', () => {
    const db = new Database(':memory:'); runMigrations(db);
    try {
      const index = new SqliteEventJournalSegmentIndex(db);
      for (let batch = 0; batch < 300; batch++) index.indexTraceEvents('account', 'conversation',
        Array.from({ length: 100 }, (_, n) => {
          const sequence = batch * 100 + n; const id = `event_${sequence}`;
          return { turnId: 'turn', eventId: id, gatewaySequence: sequence,
            position: { sequence, eventKey: id, eventId: id }, value: { id, sequence, summary: '安全进度🙂'.repeat(100) } };
        }), batch * 100 + 99);
      const first = index.tracePage('account', 'conversation', 'turn', null, 50, 32 * 1024);
      expect(first.events.length).toBeGreaterThan(0);
      expect(first.events.length).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(JSON.stringify(first.events))).toBeLessThanOrEqual(32 * 1024);
      expect(first.hasMore).toBe(true);
      expect(index.tracePage('other', 'conversation', 'turn', null, 50, 32768).events).toEqual([]);
    } finally { db.close(); }
  });
});
