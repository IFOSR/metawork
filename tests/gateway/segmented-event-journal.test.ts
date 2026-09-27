import Database from 'better-sqlite3';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { SegmentedEventJournal } from '../../src/gateway/segmented-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0)) await cleanup(); });
function event(n: number, turn = 'turn_one'): GatewayEventEnvelope {
  return {
    protocolVersion: 2, eventId: `event_${n}`, sequence: 0,
    accountId: 'local-default', conversationId: 'conv_one', requestId: 'req_one', turnId: turn,
    kind: 'final_answer', payload: { lines: [`Answer ${n}`] }, occurredAt: '2026-09-26T00:00:00Z',
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'segmented-journal-'));
  const db = new Database(join(root, 'index.db'));
  runMigrations(db);
  const index = new SqliteEventJournalSegmentIndex(db);
  const legacy = new FileEventJournal(root);
  const journal = new SegmentedEventJournal(root, index, legacy);
  close.push(async () => { await journal.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, index, legacy, journal };
}

describe('appendable Gateway journal', () => {
  it('imports every retained legacy fact rather than an already-compacted replay projection', async () => {
    const { journal, legacy } = await fixture();
    const originals = await legacy.appendBatch([1, 2, 3].map(n => ({
      ...event(n), kind: 'trace_delta' as const, payload: {
        events: [{ id: `trace_${n}`, sequence: n, kind: 'progress', summary: `Progress ${n}` }],
      },
    })));
    const imported = await journal.replay('local-default', 'conv_one');
    expect(imported.deltas).toEqual(originals);
    expect(await journal.append(originals[0]!)).toEqual(originals[0]);
  });

  it('splits a large atomic batch into byte-bounded segments, including legacy import', async () => {
    const { root, journal, index, legacy } = await fixture();
    const events = Array.from({ length: 36 }, (_, n) => ({
      ...event(n), payload: { lines: ['x'.repeat(60_000)] },
    }));
    await journal.appendBatch(events);
    const segments = index.segments('local-default', 'conv_one', 0);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect((await stat(join(root, 'local-default', 'conv_one.segments', `${segment.id}.json`))).size)
        .toBeLessThanOrEqual(256 * 1024);
    }
    await legacy.appendBatch(events.map(item => ({ ...item, conversationId: 'conv_legacy' })));
    await journal.snapshot('local-default', 'conv_legacy');
    expect(index.segments('local-default', 'conv_legacy', 0).length).toBeGreaterThan(1);
    expect((await journal.replay('local-default', 'conv_one')).deltas).toHaveLength(36);
  });

  it('does not grow a compacted segment beyond the byte budget on subsequent passes', async () => {
    const { root, journal, index } = await fixture();
    for (let n = 0; n < 24; n += 1) {
      await journal.append({ ...event(n), payload: { lines: ['x'.repeat(60_000)] } });
      await journal.compact('local-default', 'conv_one');
    }
    const segments = index.segments('local-default', 'conv_one', 0);
    for (const segment of segments) {
      expect((await stat(join(root, 'local-default', 'conv_one.segments', `${segment.id}.json`))).size)
        .toBeLessThanOrEqual(256 * 1024);
    }
    expect(segments.length).toBeLessThan(24);
    expect((await journal.replay('local-default', 'conv_one')).deltas).toHaveLength(24);
  });

  it('bounds reconnect reads and explicitly resets an oversized or future cursor without losing audit', async () => {
    const { journal } = await fixture();
    await journal.appendBatch(Array.from({ length: 30 }, (_, n) => ({
      ...event(n), payload: { lines: ['x'.repeat(60_000)] },
    })));
    const reset = await journal.resume('local-default', 'conv_one', 1);
    expect(reset.cursorReset).toEqual({ reason: 'replay_budget_exceeded', sequence: 30 });
    expect(reset.deltas).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(reset))).toBeLessThan(300_000);
    const future = await journal.resume('local-default', 'conv_one', 100);
    expect(future.cursorReset).toEqual({ reason: 'cursor_ahead', sequence: 30 });
    expect((await journal.resume('local-default', 'conv_one', 29)).deltas.map(item => item.sequence)).toEqual([30]);
    expect((await journal.replay('local-default', 'conv_one')).deltas).toHaveLength(30);
  });

  it('remembers the legacy replay coverage boundary after migration and restart', async () => {
    const { root, journal, index, legacy } = await fixture();
    await legacy.appendBatch(Array.from({ length: 250 }, (_, n) => ({
      ...event(n), kind: 'execution_delta' as const, payload: { progress: n },
    })));
    await journal.snapshot('local-default', 'conv_one');
    const reopened = new SegmentedEventJournal(root, index, legacy);
    await reopened.append({ ...event(250), kind: 'execution_delta', payload: { progress: 250 } });
    expect((await reopened.resume('local-default', 'conv_one', 1)).cursorReset)
      .toEqual({ reason: 'cursor_expired', sequence: 251 });
    expect((await reopened.resume('local-default', 'conv_one', 50)).cursorReset).toBeUndefined();
    await reopened.close();
  });

  it('cleans abandoned files after failed commits while retaining every committed segment', async () => {
    const { root, journal, index, legacy } = await fixture();
    await journal.append(event(1));
    const fail = vi.spyOn(index, 'commit').mockImplementationOnce(() => { throw new Error('crash'); });
    await expect(journal.append(event(2))).rejects.toThrow('crash');
    fail.mockRestore();
    const reopened = new SegmentedEventJournal(root, index, legacy);
    await reopened.maintain('local-default', 'conv_one');
    const files = await readdir(join(root, 'local-default', 'conv_one.segments'));
    expect(files.sort()).toEqual(index.segments('local-default', 'conv_one', 0).map(s => `${s.id}.json`).sort());
    expect((await reopened.replay('local-default', 'conv_one')).deltas.map(item => item.eventId)).toEqual(['event_1']);
    await reopened.close();
  });

  it.each(['before', 'after'] as const)('recovers a compaction interruption %s the atomic index switch', async phase => {
    const { root, journal, index, legacy } = await fixture();
    for (let n = 0; n < 4; n += 1) await journal.append(event(n));
    const before = await journal.replay('local-default', 'conv_one');
    const replace = index.replaceSegments.bind(index);
    const fail = vi.spyOn(index, 'replaceSegments').mockImplementationOnce((...args) => {
      if (phase === 'after') replace(...args);
      throw new Error('compaction interrupted');
    });
    await expect(journal.compact('local-default', 'conv_one')).rejects.toThrow('compaction interrupted');
    fail.mockRestore();
    const reopened = new SegmentedEventJournal(root, index, legacy);
    expect(await reopened.replay('local-default', 'conv_one')).toEqual(before);
    await reopened.maintain('local-default', 'conv_one');
    expect(await reopened.replay('local-default', 'conv_one')).toEqual(before);
    expect((await reopened.append(event(0))).sequence).toBe(1);
    expect((await readdir(join(root, 'local-default', 'conv_one.segments'))).sort())
      .toEqual(index.segments('local-default', 'conv_one', 0).map(segment => `${segment.id}.json`).sort());
    await reopened.close();
  });

  it('imports legacy once, preserves it, and reads bounded snapshots without replay', async () => {
    const { root, legacy, journal, index } = await fixture();
    await legacy.appendBatch(Array.from({ length: 40 }, (_, i) => event(i, `turn_${i}`)));
    const old = await readFile(join(root, 'local-default', 'conv_one.json'), 'utf8');
    const replay = vi.spyOn(legacy, 'replay');
    const exportRetained = vi.spyOn(legacy, 'exportRetained');
    const snapshot = await journal.snapshot('local-default', 'conv_one');
    expect(snapshot.snapshotVersion).toBe(1);
    expect(snapshot.snapshot.every(item => item.turnId === 'turn_39')).toBe(true);
    const reopened = new SegmentedEventJournal(root, index, legacy);
    await reopened.append(event(40, 'turn_new'));
    await reopened.snapshot('local-default', 'conv_one');
    expect(replay).not.toHaveBeenCalled();
    expect(exportRetained).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, 'local-default', 'conv_one.json'), 'utf8')).toBe(old);
    expect((await reopened.replay('local-default', 'conv_one', 39)).deltas.map(item => item.eventId))
      .toEqual(['event_39', 'event_40']);
  });

  it('does not rewrite a version-one legacy file during migration', async () => {
    const { root, journal, legacy } = await fixture();
    await legacy.append(event(1));
    const path = join(root, 'local-default', 'conv_one.json');
    const old = JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), version: 1 });
    await writeFile(path, old);
    await journal.snapshot('local-default', 'conv_one');
    expect(await readFile(path, 'utf8')).toBe(old);
  });

  it('serializes appends and permanently deduplicates event IDs, including after restart', async () => {
    const { root, journal, index, legacy } = await fixture();
    const appended = await Promise.all(Array.from({ length: 20 }, (_, n) => journal.append(event(n))));
    expect(appended.map(item => item.sequence)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    const reopened = new SegmentedEventJournal(root, index, legacy);
    expect(await reopened.append(event(0))).toEqual(appended[0]);
    expect(await reopened.lastSequence('local-default', 'conv_one')).toBe(20);
    const reserved = await reopened.reserveSequence('local-default', 'conv_one');
    expect((await reopened.append(event(21))).sequence).toBe(reserved + 1);
  });

  it('does not expose an orphan segment when index commit fails', async () => {
    const { root, journal, index, legacy } = await fixture();
    await journal.append(event(1));
    const fail = vi.spyOn(index, 'commit').mockImplementationOnce(() => { throw new Error('crash'); });
    await expect(journal.append(event(2))).rejects.toThrow('crash');
    fail.mockRestore();
    const reopened = new SegmentedEventJournal(root, index, legacy);
    expect((await reopened.snapshot('local-default', 'conv_one')).lastSequence).toBe(1);
    expect((await reopened.append(event(2))).sequence).toBe(2);
    const replay = await reopened.replay('local-default', 'conv_one', 0);
    expect(replay.deltas.map(item => item.eventId)).toEqual(['event_1', 'event_2']);
  });

  it('keeps result audit bodies but bounds the attach snapshot independently', async () => {
    const { journal } = await fixture();
    const events = Array.from({ length: 50 }, (_, n) => ({
      ...event(n), kind: 'result_chunk' as const,
      payload: { resultId: 'result_one', offset: n * 20_000, chunk: 'x'.repeat(20_000) },
    }));
    await journal.appendBatch(events);
    const snapshot = await journal.snapshot('local-default', 'conv_one');
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(300_000);
    expect((await journal.replay('local-default', 'conv_one', 0)).deltas).toHaveLength(50);
  });

  it('compacts committed segments without changing sequences, replay or idempotency', async () => {
    const { journal } = await fixture();
    for (let n = 0; n < 6; n += 1) await journal.append(event(n));
    const before = await journal.replay('local-default', 'conv_one', 0);
    await journal.compact('local-default', 'conv_one');
    expect(await journal.replay('local-default', 'conv_one', 0)).toEqual(before);
    expect((await journal.append(event(0))).sequence).toBe(1);
  });
});
