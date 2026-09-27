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
