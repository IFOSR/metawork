import Database from 'better-sqlite3';
import { writeSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import { DatabaseBackup } from '../../src/installation/database-backup.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const accountId = 'local-default';
const conversationId = 'conv_recovery';
const [root, action, operation, phase] = process.argv.slice(2);
if (!root || !action) throw new Error('fixture root and action required');
const journalRoot = join(root, 'journal');
const segmentRoot = join(journalRoot, accountId, `${conversationId}.segments`);
const legacyPath = join(journalRoot, accountId, `${conversationId}.json`);
const db = new Database(join(root, 'index.db'), { fileMustExist: action !== 'seed' });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
const index = new SqliteEventJournalSegmentIndex(db);
const legacy = new FileEventJournal(journalRoot);
const runtime = createAccountEventJournal({
  db, root: journalRoot, accountId,
  onError: error => { throw error; },
});

function event(n: number): GatewayEventEnvelope {
  return {
    protocolVersion: 2, accountId, conversationId, eventId: `event_${n}`, sequence: 0,
    requestId: `request_${n}`, turnId: `turn_${n}`,
    occurredAt: '2026-09-27T00:00:00.000Z',
    kind: n === 3 ? 'result_chunk' : 'final_answer',
    payload: n === 3
      ? { resultId: 'result_audit', offset: 0, chunk: 'Retain the complete result body.' }
      : { lines: [`Answer ${n}`], artifactRefs: [`artifact_${n}`], amountMicroCoin: `${n * 10}` },
  };
}

function emit(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

function pause(): never {
  // Synchronous notification works even inside a SQLite callback/transaction.
  emit({ paused: true, operation, phase, inTransaction: db.inTransaction });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('fixture pause unexpectedly resumed');
}

function armInterruption(): void {
  if (!['import', 'append', 'compact'].includes(operation ?? '')
    || !['before', 'during', 'after'].includes(phase ?? '')) throw new Error('invalid interruption');
  if (phase === 'during') {
    db.function('fixture_pause', pause);
    // TEMP schema only: interrupt after the first event index mutation, while
    // the production transaction has already inserted its new segment row.
    db.exec(`
      CREATE TEMP TRIGGER fixture_pause_index
      AFTER ${operation === 'compact' ? 'UPDATE' : 'INSERT'} ON gateway_journal_event_index
      BEGIN SELECT fixture_pause(); END;
    `);
  } else if (operation === 'compact') {
    const replace = SqliteEventJournalSegmentIndex.prototype.replaceSegments;
    SqliteEventJournalSegmentIndex.prototype.replaceSegments = function (...args) {
      if (phase === 'before') pause();
      replace.apply(this, args);
      pause();
    };
  } else {
    const commit = SqliteEventJournalSegmentIndex.prototype.commit;
    SqliteEventJournalSegmentIndex.prototype.commit = function (...args) {
      if (phase === 'before') pause();
      commit.apply(this, args);
      pause();
    };
  }
}

async function diskState() {
  return {
    state: index.read(accountId, conversationId),
    segments: index.segments(accountId, conversationId, 0),
    events: db.prepare(`
      SELECT event_id AS eventId, sequence, segment_id AS segmentId FROM gateway_journal_event_index
      WHERE account_id = ? AND conversation_id = ? ORDER BY sequence
    `).all(accountId, conversationId),
    files: (await readdir(segmentRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).sort(),
    legacySha256: createHash('sha256').update(await readFile(legacyPath)).digest('hex'),
    integrity: db.pragma('integrity_check'),
    foreignKeys: db.pragma('foreign_key_check'),
  };
}

async function main() {
  if (action === 'seed') {
    runMigrations(db);
    await legacy.appendBatch([1, 2, 3].map(event));
    if (operation !== 'import') {
      await runtime.journal.snapshot(accountId, conversationId);
      for (const n of [4, 5]) await runtime.journal.append(event(n));
    }
    emit({ disk: await diskState(), legacy: await legacy.exportRetained(accountId, conversationId) });
  } else if (action === 'interrupt') {
    armInterruption();
    if (operation === 'import') await runtime.journal.snapshot(accountId, conversationId);
    else if (operation === 'append') await runtime.journal.appendBatch([event(6), event(7)]);
    else await runtime.journal.compact(accountId, conversationId);
    throw new Error('interruption hook was not reached');
  } else if (action === 'recover') {
    const before = await diskState();
    const replay = await runtime.journal.replay(accountId, conversationId);
    const snapshot = await runtime.journal.snapshot(accountId, conversationId);
    const resume = await runtime.journal.resume(accountId, conversationId, operation === 'import' ? 0 : 5);
    const duplicate = await runtime.journal.append(event(1));
    const retry = operation === 'append'
      ? await runtime.journal.appendBatch([event(6), event(7)])
      : [await runtime.journal.append(event(operation === 'import' ? 4 : 6))];
    let complete = false;
    let passes = 0;
    while (!complete && passes++ < 10) {
      complete = await runtime.journal.maintain(accountId, conversationId);
    }
    if (!complete) throw new Error('fixture maintenance did not converge');
    emit({
      before, replay, snapshot, resume, duplicate, retry,
      recovered: await runtime.journal.replay(accountId, conversationId), disk: await diskState(),
    });
  } else if (action === 'read') {
    emit({
      disk: await diskState(), replay: await runtime.journal.replay(accountId, conversationId),
      snapshot: await runtime.journal.snapshot(accountId, conversationId),
    });
  } else if (action === 'backup-compaction-boundary') {
    const backupPath = join(root, 'before-compaction.db');
    await new DatabaseBackup().backup(db, backupPath);
    await runtime.journal.compact(accountId, conversationId);
    const oldDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
    const oldRuntime = createAccountEventJournal({
      db: oldDatabase, root: journalRoot, accountId,
      onError: error => { throw error; },
    });
    try {
      const oldIndex = new SqliteEventJournalSegmentIndex(oldDatabase);
      let rollbackReadError: string | null = null;
      try { await oldRuntime.journal.replay(accountId, conversationId); }
      catch (error) {
        rollbackReadError = (error as NodeJS.ErrnoException).code ?? String(error);
      }
      emit({
        oldState: oldIndex.read(accountId, conversationId),
        oldSegments: oldIndex.segments(accountId, conversationId, 0),
        rollbackReadError,
        current: await runtime.journal.replay(accountId, conversationId),
        disk: await diskState(),
      });
    } finally {
      await oldRuntime.stop();
      oldDatabase.close();
    }
  } else if (action === 'rollback-boundary') {
    await runtime.journal.snapshot(accountId, conversationId);
    const backupPath = join(root, 'before-write.db');
    const backup = await new DatabaseBackup().backup(db, backupPath);
    const before = await diskState();
    const appended = await runtime.journal.append(event(4));
    const oldDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      emit({
        backup, before, appended,
        oldState: new SqliteEventJournalSegmentIndex(oldDatabase).read(accountId, conversationId),
        legacy: await legacy.exportRetained(accountId, conversationId),
        current: await runtime.journal.replay(accountId, conversationId),
        disk: await diskState(),
      });
    } finally { oldDatabase.close(); }
  } else {
    throw new Error(`unknown fixture action: ${action}`);
  }
}

main().then(async () => {
  await runtime.stop();
  db.close();
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
