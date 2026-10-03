import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../../src/gateway/segmented-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { EventJournal } from '../../src/gateway/event-journal.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function traceDelta(number: number, sequence = number): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: `delta_${number}`,
    sequence: 0,
    accountId: 'local-default',
    conversationId: 'conv_trace',
    requestId: 'request_1',
    turnId: 'turn_trace',
    kind: 'trace_delta',
    payload: {
      events: [{
        id: `trace_${number}`,
        eventKey: `source:${number}`,
        sequence,
        occurredAt: `2026-10-01T00:00:${String(number).padStart(2, '0')}.000Z`,
        phase: 'execution',
        actor: 'executor',
        kind: 'progress',
        status: 'completed',
        title: `事件 ${number}`,
        summary: 'safe',
        details: {},
      }],
    },
    occurredAt: '2026-10-01T00:00:00.000Z',
  };
}

async function fileFixture(): Promise<FileEventJournal> {
  const root = await mkdtemp(join(tmpdir(), 'trace-page-file-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new FileEventJournal(root);
}

async function segmentedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'trace-page-segmented-'));
  const db = new Database(join(root, 'index.db'));
  runMigrations(db);
  const index = new SqliteEventJournalSegmentIndex(db);
  const legacy = new FileEventJournal(root);
  const journal = new SegmentedEventJournal(root, index, legacy);
  cleanups.push(async () => { await journal.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { journal, db, index, root };
}

async function assertPages(journal: EventJournal): Promise<void> {
  await journal.appendBatch?.(Array.from({ length: 9 }, (_, index) => traceDelta(index + 1)));
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await journal.readTracePage!('local-default', 'conv_trace', 'turn_trace', cursor, 2);
    all.push(...page.events.map(event => String(event.id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(all).toEqual(Array.from({ length: 9 }, (_, index) => `trace_${index + 1}`));
  const first = await journal.readTracePage!('local-default', 'conv_trace', 'turn_trace', undefined, 2);
  expect(first.nextCursor).toBeTruthy();
  const repeated = await journal.readTracePage!('local-default', 'conv_trace', 'turn_trace', first.nextCursor!, 2);
  expect(repeated.events.map(event => event.id)).toEqual(['trace_3', 'trace_4']);
  const recent = await journal.readTracePage!('local-default', 'conv_trace', 'turn_trace', undefined, 2, true);
  expect(recent.events.map(event => event.id)).toEqual(['trace_8', 'trace_9']);
  expect(recent.nextCursor).toBeNull();
  await expect(journal.readTracePage!('local-default', 'conv_trace', 'turn_trace', '1', 2))
    .rejects.toThrow('invalid_trace_cursor');
}

describe('trace page cursors', () => {
  it('replays every FileEventJournal trace exactly once across pages', async () => {
    await assertPages(await fileFixture());
  });

  it('replays every SegmentedEventJournal trace exactly once across pages', async () => {
    await assertPages((await segmentedFixture()).journal);
  });

  it('reads indexed pages without opening historical segment files, including after compaction', async () => {
    const { journal, index, root } = await segmentedFixture();
    for (let n = 1; n <= 12; n++) await journal.append(traceDelta(n));
    await journal.compact('local-default', 'conv_trace');
    for (const segment of index.segments('local-default', 'conv_trace', 0)) {
      await rm(join(root, 'local-default', 'conv_trace.segments', `${segment.id}.json`));
    }
    const page = await journal.readTracePage('local-default', 'conv_trace', 'turn_trace', undefined, 3);
    expect(page.events.map(event => event.id)).toEqual(['trace_1', 'trace_2', 'trace_3']);
    expect(page.preparing).toBeUndefined();
    expect(page.nextCursor).toBeTruthy();
    const recent = await journal.readTracePage('local-default', 'conv_trace', 'turn_trace', undefined, 3, true);
    expect(recent.events.map(event => event.id)).toEqual(['trace_10', 'trace_11', 'trace_12']);
  });

  it('rebuilds schema-46 trace history off the read path without overwriting a newer live update', async () => {
    const { journal, db } = await segmentedFixture();
    await journal.append(traceDelta(1));
    db.exec(`DROP TABLE gateway_trace_read_events; DROP TABLE gateway_trace_read_heads;
      UPDATE schema_version SET version = 46;`);
    runMigrations(db);
    const initial = await journal.readTracePage('local-default', 'conv_trace', 'turn_trace');
    expect(initial.events).toEqual([]);
    expect(initial.preparing).toBe(true);
    const newer = traceDelta(1);
    await journal.append({ ...newer, eventId: 'updated', payload: {
      events: [{ id: 'trace_1', eventKey: 'source:1', sequence: 1, title: 'Updated' }],
    } });
    await journal.maintain('local-default', 'conv_trace');
    await journal.maintain('local-default', 'conv_trace');
    const rebuilt = await journal.readTracePage('local-default', 'conv_trace', 'turn_trace');
    expect(rebuilt.events).toHaveLength(1);
    expect(rebuilt.events[0]!.title).toBe('Updated');
    expect(rebuilt.preparing).toBeUndefined();
  });

  it('commits trace values and source checkpoint atomically with the journal', async () => {
    const { journal, db, index } = await segmentedFixture();
    await journal.append(traceDelta(1));
    db.exec(`CREATE TRIGGER reject_journal_commit BEFORE UPDATE ON gateway_journal_streams
      WHEN NEW.last_sequence > 1 BEGIN SELECT RAISE(ABORT, 'simulated_crash'); END;`);
    await expect(journal.append(traceDelta(2))).rejects.toThrow('simulated_crash');
    const page = await journal.readTracePage('local-default', 'conv_trace', 'turn_trace');
    expect(page.events.map(event => event.id)).toEqual(['trace_1']);
    expect(index.traceCheckpoint('local-default', 'conv_trace')).toBe(1);
  });

  it('keeps tied sequence and event keys pageable using the event identity', async () => {
    const { journal } = await segmentedFixture();
    await journal.append({ ...traceDelta(1), payload: {
      events: ['a', 'b', 'c'].map(id => ({ id, sequence: 1, eventKey: 'same', title: id })),
    } });
    let cursor: string | undefined;
    const ids: unknown[] = [];
    do {
      const page = await journal.readTracePage('local-default', 'conv_trace', 'turn_trace', cursor, 1);
      ids.push(...page.events.map(event => event.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
