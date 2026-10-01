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

async function segmentedFixture(): Promise<SegmentedEventJournal> {
  const root = await mkdtemp(join(tmpdir(), 'trace-page-segmented-'));
  const db = new Database(join(root, 'index.db'));
  runMigrations(db);
  const index = new SqliteEventJournalSegmentIndex(db);
  const legacy = new FileEventJournal(root);
  const journal = new SegmentedEventJournal(root, index, legacy);
  cleanups.push(async () => { await journal.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return journal;
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
  await expect(journal.readTracePage!('local-default', 'conv_trace', 'turn_trace', '1', 2))
    .rejects.toThrow('invalid_trace_cursor');
}

describe('trace page cursors', () => {
  it('replays every FileEventJournal trace exactly once across pages', async () => {
    await assertPages(await fileFixture());
  });

  it('replays every SegmentedEventJournal trace exactly once across pages', async () => {
    await assertPages(await segmentedFixture());
  });
});
