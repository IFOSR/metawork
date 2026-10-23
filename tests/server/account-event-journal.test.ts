import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { runMigrations } from '../../src/storage/migrations.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

it('uses a single segmented writer, retaining the legacy file only for import and rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'account-journal-'));
  const db = new Database(':memory:');
  const onError = vi.fn();
  let runtime: ReturnType<typeof createAccountEventJournal> | undefined;
  try {
    runMigrations(db);
    const old: GatewayEventEnvelope = {
      protocolVersion: 2, accountId: 'local-default', conversationId: 'conv_one', eventId: 'legacy',
      turnId: 'turn_one', requestId: 'request_one', sequence: 0, kind: 'final_answer',
      occurredAt: '2026-09-26T00:00:00Z', payload: { lines: ['original answer'] },
    };
    const legacy = new FileEventJournal(root);
    await legacy.append(old);
    const original = await readFile(join(root, 'local-default', 'conv_one.json'), 'utf8');
    runtime = createAccountEventJournal({ db, root, accountId: 'local-default', onError });
    runtime.start();
    expect((await runtime.journal.snapshot('local-default', 'conv_one')).lastSequence).toBe(1);
    await runtime.journal.append({ ...old, eventId: 'new', payload: { lines: ['new answer'] } });
    expect((await runtime.journal.resume('local-default', 'conv_one', 1)).deltas.at(-1)?.eventId).toBe('new');
    await runtime.stop();
    runtime = undefined;
    expect(await readFile(join(root, 'local-default', 'conv_one.json'), 'utf8')).toBe(original);
    const restored = createAccountEventJournal({ db, root, accountId: 'local-default', onError });
    try {
      expect((await restored.journal.snapshot('local-default', 'conv_one')).lastSequence).toBe(2);
    } finally { await restored.stop(); }
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await runtime?.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reports whether a maintenance pass did work so the loop can idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'account-journal-work-'));
  const db = new Database(':memory:');
  let runtime: ReturnType<typeof createAccountEventJournal> | undefined;
  try {
    runMigrations(db);
    runtime = createAccountEventJournal({ db, root, accountId: 'local-default', onError: vi.fn() });
    const base: GatewayEventEnvelope = {
      protocolVersion: 2, accountId: 'local-default', conversationId: 'conv_work', eventId: 'event_1',
      turnId: 'turn_one', requestId: 'request_one', sequence: 0, kind: 'final_answer',
      occurredAt: '2026-09-26T00:00:00Z', payload: { lines: ['answer'] },
    };
    await runtime.journal.append(base);
    await runtime.journal.append({ ...base, eventId: 'event_2', sequence: 1 });
    let done = false;
    const passes: { done: boolean; didWork: boolean }[] = [];
    for (let n = 0; n < 20 && !done; n += 1) {
      const pass = await runtime.maintainOnce('local-default', 'conv_work');
      passes.push(pass);
      done = pass.done;
    }
    expect(done).toBe(true);
    expect(passes.some(pass => pass.didWork)).toBe(true);
    // A converged stream performs no durable work, so the loop may sleep.
    expect(await runtime.maintainOnce('local-default', 'conv_work'))
      .toEqual({ done: true, didWork: false });
    // Steady state stays idle: the loop may now back off to its idle interval.
    expect(await runtime.maintainOnce('local-default', 'conv_work'))
      .toEqual({ done: true, didWork: false });
  } finally {
    await runtime?.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('surfaces a corrupt half-projected history row as a failing pass with its Conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'account-journal-corrupt-'));
  const db = new Database(':memory:');
  let runtime: ReturnType<typeof createAccountEventJournal> | undefined;
  try {
    runMigrations(db);
    runtime = createAccountEventJournal({ db, root, accountId: 'local-default', onError: vi.fn() });
    // A half-completed import: the stream exists and the checkpoint is behind,
    // but the stored body cannot be projected.
    db.prepare(`INSERT INTO conversation_history_streams (account_id, conversation_id, kind, last_sequence)
      VALUES ('local-default', 'conv_corrupt', 'conversation', 1)`).run();
    db.prepare(`INSERT INTO conversation_history_turns
      (account_id, conversation_id, kind, sequence, turn_id, body_json, byte_length)
      VALUES ('local-default', 'conv_corrupt', 'conversation', 1, 'turn_1', 'null', 4)`).run();
    // The pass fails loudly instead of silently dropping the stream: the loop
    // wrapper adds the Conversation and stack to the report.
    await expect(runtime.maintainOnce('local-default', 'conv_corrupt')).rejects.toThrow();
    // A healthy stream is unaffected by the damaged one.
    expect((await runtime.maintainOnce('local-default', 'conv_healthy')).done).toBe(true);
  } finally {
    await runtime?.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
