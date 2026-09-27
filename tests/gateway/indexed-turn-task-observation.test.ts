import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../../src/gateway/segmented-event-journal.js';
import { resolveTaskViewTurnAssociation } from '../../src/gateway/task-view-association.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';

const scope = { accountId: 'local-default', conversationId: 'conv_one', turnId: 'turn_one' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function trace(n: number, taskId: string | null = 'task_one', turnId = scope.turnId): GatewayEventEnvelope {
  return {
    protocolVersion: 2, eventId: `event_${n}`, sequence: 0, ...scope, turnId, requestId: null,
    kind: 'trace_delta', payload: { taskId, status: 'completed', events: [{ summary: `progress ${n}` }] },
    occurredAt: `2026-09-26T00:00:0${n}.000Z`,
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'indexed-turn-task-'));
  let db = new Database(join(root, 'index.db'));
  runMigrations(db);
  let index = new SqliteEventJournalSegmentIndex(db);
  const legacy = new FileEventJournal(root);
  let journal = new SegmentedEventJournal(root, index, legacy);
  cleanups.push(async () => { await journal.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, legacy,
    get db() { return db; }, get index() { return index; }, get journal() { return journal; },
    async reopen() {
      await journal.close();
      db.close();
      db = new Database(join(root, 'index.db'));
      index = new SqliteEventJournalSegmentIndex(db);
      journal = new SegmentedEventJournal(root, index, legacy);
    },
    read: (turnId = scope.turnId) => journal.readTurnTaskObservation(scope.accountId, scope.conversationId, turnId),
  };
}

describe('indexed historical Turn Task observations', () => {
  it('imports retained legacy traces once, preserving first/latest fields across restart and compaction', async () => {
    const f = await fixture();
    await f.legacy.appendBatch([trace(1, null), trace(2), trace(3)]);
    const legacyPath = join(f.root, scope.accountId, `${scope.conversationId}.json`);
    const original = await readFile(legacyPath, 'utf8');
    const exportRetained = vi.spyOn(f.legacy, 'exportRetained');
    const imported = await f.read();
    expect(imported).toMatchObject({
      lastSequence: 3, observation: {
        ...scope, taskIds: ['task_one'], firstTraceAt: trace(1).occurredAt,
        latestTraceAt: trace(3).occurredAt, completedAt: trace(3).occurredAt, progressSummary: 'progress 3',
      },
    });
    await f.journal.append(trace(4, 'task_one', 'turn_new'));
    await f.journal.append(trace(5, 'task_one', 'turn_new'));
    await f.journal.compact(scope.accountId, scope.conversationId);
    await f.reopen();
    const noSegments = vi.spyOn(f.index, 'segments').mockImplementation(() => { throw new Error('no body scan'); });
    const noReplay = vi.spyOn(f.journal, 'replay').mockRejectedValue(new Error('no replay'));
    const reopened = await f.read();
    expect(reopened).toEqual({ ...imported, lastSequence: 5 });
    expect(exportRetained).toHaveBeenCalledTimes(1);
    expect(noSegments).not.toHaveBeenCalled();
    expect(noReplay).not.toHaveBeenCalled();
    expect(await readFile(legacyPath, 'utf8')).toBe(original);
  });

  it('keeps ambiguity after later singleton traces, duplicate appends, reservations, restart and compaction', async () => {
    const f = await fixture();
    for (let n = 1; n <= 4; n += 1) await f.journal.append(trace(n, `task_${n}`));
    const before = await f.read();
    expect(before.observation?.taskIds).toEqual(['task_1', 'task_2']);
    await f.journal.append(trace(1, 'forged_replacement'));
    expect(await f.read()).toEqual(before);
    await f.journal.append(trace(5, 'task_1'));
    await f.journal.reserveSequence(scope.accountId, scope.conversationId);
    await f.journal.compact(scope.accountId, scope.conversationId);
    await f.reopen();
    const after = await f.read();
    expect(after.lastSequence).toBe(6);
    expect(after.observation?.taskIds).toEqual(['task_1', 'task_2']);
    expect(after.observation?.firstTraceAt).toBe(trace(1).occurredAt);
    expect(after.observation?.latestTraceAt).toBe(trace(5).occurredAt);
    expect(resolveTaskViewTurnAssociation({ ...scope, taskId: 'task_1', traceObservation: after.observation }))
      .toEqual({ status: 'mismatch' });
  });

  it('imports every retained legacy Task identity rather than the latest trace snapshot alone', async () => {
    const f = await fixture();
    await f.legacy.appendBatch([trace(1, 'task_one'), trace(2, 'task_two'), trace(3, 'task_one')]);
    const noLegacyReplay = vi.spyOn(f.legacy, 'replay').mockRejectedValue(new Error('not a migration source'));
    expect((await f.read()).observation).toMatchObject({
      taskIds: ['task_one', 'task_two'], firstTraceAt: trace(1).occurredAt, latestTraceAt: trace(3).occurredAt,
    });
    await f.reopen();
    const after = await f.read();
    expect(resolveTaskViewTurnAssociation({ ...scope, taskId: 'task_one', traceObservation: after.observation }))
      .toEqual({ status: 'mismatch' });
    expect(noLegacyReplay).not.toHaveBeenCalled();
  });

  it('serializes observations and their watermark with appends, including sanitized progress', async () => {
    const f = await fixture();
    const appended = f.journal.append(trace(1));
    const firstRead = f.read();
    await appended;
    expect(await firstRead).toMatchObject({ lastSequence: 1, observation: { progressSummary: 'progress 1' } });
    const unsafe = {
      ...trace(2), payload: { taskId: 'task_one', events: [{ summary: 'token=secret_value_for_review' }] },
    };
    const stored = await f.journal.append(unsafe);
    const observation = (await f.read()).observation!;
    const storedPayload = stored.payload as { events: { summary: string }[] };
    expect(observation.progressSummary).toBe(storedPayload.events[0]!.summary);
    expect(observation.progressSummary).not.toContain('secret_value_for_review');
    expect(observation.firstTraceAt).toBe(trace(1).occurredAt);
  });

  it('persists both envelope and payload identities and scopes exact reads by account and Conversation', async () => {
    const f = await fixture();
    await f.journal.append({
      ...trace(1), payload: { taskId: 'task_one', turnId: 'payload_turn' },
    });
    expect((await f.read()).observation?.taskIds).toEqual(['task_one']);
    expect((await f.read('payload_turn')).observation?.taskIds).toEqual(['task_one']);
    expect((await f.read('missing')).observation).toBeNull();
    expect((await f.journal.readTurnTaskObservation('other', scope.conversationId, scope.turnId)).observation).toBeNull();
    expect((await f.journal.readTurnTaskObservation(scope.accountId, 'conv_other', scope.turnId)).observation).toBeNull();
  });

  it('rolls back every observation, segment and watermark on a failed multi-Turn append', async () => {
    const f = await fixture();
    await f.journal.append(trace(1));
    const before = await f.read();
    f.db.exec(`CREATE TEMP TRIGGER fail_observation BEFORE INSERT ON gateway_turn_task_observations
      WHEN NEW.turn_id = 'turn_fail'
      BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END`);
    await expect(f.journal.appendBatch([trace(2), trace(3, 'task_other', 'turn_fail')]))
      .rejects.toThrow('injected observation failure');
    expect(await f.read()).toEqual(before);
    expect(f.index.findEvent(scope.accountId, scope.conversationId, 'event_2')).toBeNull();
    expect(f.index.segments(scope.accountId, scope.conversationId, 0)).toHaveLength(1);
    f.db.exec('DROP TRIGGER fail_observation');
    await f.reopen();
    expect(await f.read()).toEqual(before);
    await f.journal.appendBatch([trace(2), trace(3, 'task_other', 'turn_fail')]);
    expect((await f.read()).observation?.latestTraceAt).toBe(trace(2).occurredAt);
    expect((await f.read('turn_fail')).observation?.taskIds).toEqual(['task_other']);
  });

  it('retries a failed legacy import without partial associations or lost legacy evidence', async () => {
    const f = await fixture();
    await f.legacy.appendBatch([trace(1), trace(2, 'task_two', 'turn_fail')]);
    f.db.exec(`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON gateway_turn_task_observations
      WHEN NEW.turn_id = 'turn_fail'
      BEGIN SELECT RAISE(ABORT, 'injected import failure'); END`);
    await expect(f.read()).rejects.toThrow('injected import failure');
    expect(f.index.read(scope.accountId, scope.conversationId)).toBeNull();
    expect(f.index.readTurnTaskObservation(scope.accountId, scope.conversationId, scope.turnId)).toBeNull();
    expect(f.index.segments(scope.accountId, scope.conversationId, 0)).toEqual([]);
    await f.reopen();
    expect((await f.read()).observation?.taskIds).toEqual(['task_one']);
    expect((await f.read('turn_fail')).observation?.taskIds).toEqual(['task_two']);
  });
});

describe('schema43 Turn Task observation projection', () => {
  it('creates an account-scoped exact index in the transactional 42-to-43 migration', async () => {
    const f = await fixture();
    expect(f.db.prepare('PRAGMA table_info(gateway_turn_task_observations)').all()).not.toEqual([]);
    f.db.exec(`DROP TABLE gateway_turn_task_observations;
      UPDATE schema_version SET version = 42;
      CREATE TEMP TRIGGER fail_migration BEFORE UPDATE ON schema_version
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    await expect(async () => runMigrations(f.db)).rejects.toThrow('injected migration failure');
    expect(f.db.prepare('PRAGMA table_info(gateway_turn_task_observations)').all()).toEqual([]);
    expect(f.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 42 });
    f.db.exec('DROP TRIGGER fail_migration');
    runMigrations(f.db);
    expect(f.db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    const columns = f.db.prepare('PRAGMA table_info(gateway_turn_task_observations)').all() as { name: string; pk: number }[];
    expect(columns.filter(column => column.pk > 0).map(column => column.name))
      .toEqual(['account_id', 'conversation_id', 'turn_id']);
  });
});
