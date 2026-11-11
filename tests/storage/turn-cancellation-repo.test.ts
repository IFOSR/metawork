import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTurnCancellationStore } from '../../src/storage/turn-cancellation-repo.js';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { event } from '../support/plan-admission-fixture.js';

const now = '2026-11-09T00:00:00.000Z';

describe('durable Turn cancellation', () => {
  it('survives reopen and is visible on a second connection, isolated by Account, Conversation and Turn', () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-turn-cancellation-'));
    const path = join(root, 'account.sqlite');
    const first = new Database(path);
    const second = new Database(path);
    try {
      const writer = new SqliteTurnCancellationStore(first, 'account-a');
      const reader = new SqliteTurnCancellationStore(second, 'account-a');
      writer.request('conv', 'turn', now);
      writer.request('conv', 'turn', '2026-11-10T00:00:00.000Z');
      expect(reader.isRequested('conv', 'turn')).toBe(true);
      expect(reader.isRequested('other', 'turn')).toBe(false);
      expect(reader.isRequested('conv', 'other')).toBe(false);
      expect(new SqliteTurnCancellationStore(second, 'account-b').isRequested('conv', 'turn')).toBe(false);
      expect(second.prepare('SELECT requested_at FROM conversation_turn_cancellations').all())
        .toEqual([{ requested_at: now }]);
      first.close();
      second.close();
      const reopened = new Database(path);
      try {
        expect(new SqliteTurnCancellationStore(reopened, 'account-a').isRequested('conv', 'turn')).toBe(true);
        expect(reopened.prepare('PRAGMA foreign_key_list(conversation_turn_cancellations)').all()).toEqual([]);
      } finally { reopened.close(); }
    } finally {
      if (first.open) first.close();
      if (second.open) second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid identities and timestamps without writing a cancellation', () => {
    const db = new Database(':memory:');
    try {
      expect(() => new SqliteTurnCancellationStore(db, '')).toThrow('turn_cancellation_account_missing');
      const store = new SqliteTurnCancellationStore(db, 'account');
      for (const args of [['', 'turn', now], ['conv', '', now], ['conv', 'turn', 'invalid']]) {
        expect(() => store.request(args[0]!, args[1]!, args[2]!)).toThrow('invalid_turn_cancellation');
      }
      expect(db.prepare('SELECT count(*) AS count FROM conversation_turn_cancellations').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it.each(['pending', 'forwarded'] as const)('fences saved %s output and later saves without fencing another Turn', delivery => {
    const db = new Database(':memory:');
    try {
      const proposals = new PlanProposalRepo(db);
      const store = new SqliteTurnCancellationStore(db, 'account');
      const request = { ...structuredClone(event), conversationId: 'conv', sourceTurnId: 'turn' };
      proposals.save({ request });
      if (delivery === 'forwarded') proposals.markForwarded(request.id, now);
      store.request('conv', 'turn', now);
      expect(() => proposals.assertAdmissionOpen(request.id)).toThrow('turn_cancelled');
      expect(() => proposals.save({ request })).toThrow('turn_cancelled');
      expect(() => proposals.save({ request: { ...request, id: 'late',
        proposal: { ...request.proposal, id: 'plan_late' } } })).toThrow('turn_cancelled');
      const live = { ...request, id: 'live', sourceTurnId: 'next', proposal: { ...request.proposal, id: 'plan_live' } };
      proposals.save({ request: live });
      expect(() => proposals.assertAdmissionOpen(live.id)).not.toThrow();
      proposals.invalidate(live.id, 'stale', now);
      expect(() => proposals.assertAdmissionOpen(live.id)).toThrow('proposal_invalidated');
      expect(() => proposals.assertAdmissionOpen('missing')).toThrow('proposal_missing');
    } finally { db.close(); }
  });
});
