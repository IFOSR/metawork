import Database from 'better-sqlite3';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupGatewayJournal, restoreGatewayJournal,
} from '../../src/installation/gateway-journal-backup.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { SqliteEventJournalSegmentIndex } from '../../src/storage/event-journal-segment-index-repo.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(legacy = false) {
  const root = await fs.mkdtemp(join(tmpdir(), 'journal-backup-'));
  const databasePath = join(root, 'source.db');
  const journalRoot = join(root, 'events');
  const backupRoot = join(root, 'backup', 'gateway-events');
  const db = new Database(databasePath);
  if (legacy) db.exec('CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (42)');
  else runMigrations(db);
  const runtime = createAccountEventJournal({
    db, root: journalRoot, accountId: 'local-default', onError: error => { throw error; },
  });
  if (!legacy) {
    for (let n = 1; n <= 3; n++) await runtime.journal.append({
      protocolVersion: 2, accountId: 'local-default', conversationId: 'conv_backup',
      eventId: `event_${n}`, turnId: `turn_${n}`, requestId: null, sequence: 0,
      kind: 'final_answer', payload: { lines: [`Answer ${n}`] }, occurredAt: '2026-09-27T00:00:00Z',
    });
  }
  cleanups.push(async () => {
    await runtime.stop();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const input = { databasePath, journalRoot, backupRoot };
  const index = new SqliteEventJournalSegmentIndex(db);
  const paths = legacy ? [] : index.segments('local-default', 'conv_backup', 0)
    .map(row => join('local-default', 'conv_backup.segments', `${row.id}.json`));
  return { root, input, paths, db, runtime };
}

describe('Gateway journal companion backup', () => {
  it('preserves source bytes and publishes a bound, hashed manifest with a complete marker', async () => {
    const f = await fixture();
    const database = await fs.readFile(f.input.databasePath);
    const bodies = await Promise.all(f.paths.map(path => fs.readFile(join(f.input.journalRoot, path))));
    await backupGatewayJournal(f.input);
    const manifest = JSON.parse(await fs.readFile(join(f.input.backupRoot, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      version: 1, databasePath: await fs.realpath(f.input.databasePath),
      journalRoot: f.input.journalRoot,
    });
    expect(manifest.segments.map((row: { path: string }) => row.path)).toEqual(f.paths.toSorted());
    for (const row of manifest.segments) {
      expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await fs.readFile(join(f.input.backupRoot, row.path))).length).toBe(row.byteLength);
    }
    expect(JSON.parse(await fs.readFile(join(f.input.backupRoot, 'complete.json'), 'utf8')))
      .toMatchObject({ version: 1, manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await backupGatewayJournal(f.input);
    expect(await fs.readFile(f.input.databasePath)).toEqual(database);
    expect(await Promise.all(f.paths.map(path => fs.readFile(join(f.input.journalRoot, path))))).toEqual(bodies);
  });

  it('restores the previous index after candidate compaction without deleting current bodies', async () => {
    const f = await fixture();
    const before = await f.runtime.journal.replay('local-default', 'conv_backup');
    await backupGatewayJournal(f.input);
    // Copy the original index into a separate candidate exactly as the updater does.
    await f.db.backup(join(f.root, 'candidate.db'));
    const db = new Database(join(f.root, 'candidate.db'));
    const candidate = createAccountEventJournal({
      db, root: f.input.journalRoot, accountId: 'local-default', onError: error => { throw error; },
    });
    try {
      await candidate.journal.compact('local-default', 'conv_backup');
      const currentFiles = await fs.readdir(join(f.input.journalRoot, 'local-default', 'conv_backup.segments'));
      await expect(f.runtime.journal.replay('local-default', 'conv_backup')).rejects.toMatchObject({ code: 'ENOENT' });
      await restoreGatewayJournal(f.input);
      expect(await f.runtime.journal.replay('local-default', 'conv_backup')).toEqual(before);
      const restoredFiles = await fs.readdir(join(f.input.journalRoot, 'local-default', 'conv_backup.segments'));
      for (const file of currentFiles) expect(restoredFiles).toContain(file);
      expect(await candidate.journal.replay('local-default', 'conv_backup')).toEqual(before);
      await restoreGatewayJournal(f.input);
      expect(await f.runtime.journal.replay('local-default', 'conv_backup')).toEqual(before);
    } finally { await candidate.stop(); db.close(); }
  });

  it.each(['missing-directory', 'missing-marker', 'missing-body', 'corrupt-body', 'corrupt-manifest'] as const)(
    'rejects %s before restoring any missing file', async fault => {
      const f = await fixture();
      await backupGatewayJournal(f.input);
      for (const path of f.paths) await fs.unlink(join(f.input.journalRoot, path));
      if (fault === 'missing-directory') await fs.rm(f.input.backupRoot, { recursive: true });
      if (fault === 'missing-marker') await fs.unlink(join(f.input.backupRoot, 'complete.json'));
      if (fault === 'missing-body') await fs.unlink(join(f.input.backupRoot, f.paths.at(-1)!));
      if (fault === 'corrupt-body') await fs.writeFile(join(f.input.backupRoot, f.paths.at(-1)!), 'corrupt');
      if (fault === 'corrupt-manifest') await fs.writeFile(join(f.input.backupRoot, 'manifest.json'), '{}');
      await expect(restoreGatewayJournal(f.input)).rejects.toThrow();
      for (const path of f.paths) {
        await expect(fs.stat(join(f.input.journalRoot, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
  );

  it('retries an interrupted restore idempotently after an atomic body publication', async () => {
    const f = await fixture();
    await backupGatewayJournal(f.input);
    for (const path of f.paths) await fs.unlink(join(f.input.journalRoot, path));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.link).mockImplementationOnce(async (...args) => {
      await actual.link(...args);
      throw new Error('interrupted after publication');
    });
    await expect(restoreGatewayJournal(f.input)).rejects.toThrow('interrupted after publication');
    expect((await fs.readdir(join(f.input.journalRoot, 'local-default', 'conv_backup.segments')))
      .filter(path => path.endsWith('.json'))).toHaveLength(1);
    await restoreGatewayJournal(f.input);
    await restoreGatewayJournal(f.input);
    expect((await f.runtime.journal.replay('local-default', 'conv_backup')).deltas).toHaveLength(3);
  });

  it('does not publish an incomplete backup and can retry after interruption', async () => {
    const f = await fixture();
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('interrupted before publish'));
    await expect(backupGatewayJournal(f.input)).rejects.toThrow('interrupted before publish');
    await expect(fs.stat(join(f.input.backupRoot, 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await backupGatewayJournal(f.input);
    await restoreGatewayJournal(f.input);
  });

  it('checks content hashes even when a corrupted backup body retains its byte length', async () => {
    const f = await fixture();
    await backupGatewayJournal(f.input);
    const path = join(f.input.backupRoot, f.paths[0]!);
    const bytes = await fs.readFile(path);
    bytes[10] = bytes[10]! ^ 1;
    await fs.writeFile(path, bytes);
    await expect(restoreGatewayJournal(f.input)).rejects.toThrow('gateway_journal_body_hash_mismatch');
  });

  it('flushes an already published destination on restore retry', async () => {
    const f = await fixture();
    await backupGatewayJournal(f.input);
    vi.mocked(fs.open).mockClear();
    await restoreGatewayJournal(f.input);
    expect(vi.mocked(fs.open).mock.calls).toContainEqual([
      join(f.input.journalRoot, 'local-default', 'conv_backup.segments'), 'r',
    ]);
  });

  it('never replaces an existing conflicting body', async () => {
    const f = await fixture();
    await backupGatewayJournal(f.input);
    const path = join(f.input.journalRoot, f.paths[0]!);
    await fs.writeFile(path, 'different current data');
    await expect(restoreGatewayJournal(f.input)).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe('different current data');
  });

  it('does not publish a completed backup if a source segment is missing', async () => {
    const f = await fixture();
    await fs.unlink(join(f.input.journalRoot, f.paths.at(-1)!));
    await expect(backupGatewayJournal(f.input)).rejects.toThrow();
    await expect(fs.stat(join(f.input.backupRoot, 'complete.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds the companion to its previous database and exact referenced index', async () => {
    const f = await fixture();
    await backupGatewayJournal(f.input);
    const otherDatabase = join(f.root, 'different.db');
    await f.db.backup(otherDatabase);
    await expect(restoreGatewayJournal({ ...f.input, databasePath: otherDatabase })).rejects.toThrow();
    f.db.prepare('UPDATE gateway_journal_segments SET byte_length = byte_length + 1').run();
    await expect(restoreGatewayJournal(f.input)).rejects.toThrow();
  });

  it('rejects unsafe database path identities rather than reading outside the journal root', async () => {
    const f = await fixture();
    f.db.prepare("UPDATE gateway_journal_segments SET conversation_id = '../escape'").run();
    await expect(backupGatewayJournal(f.input)).rejects.toThrow();
  });

  it('does not follow segment symlinks during backup or restore', async () => {
    const f = await fixture();
    await backupGatewayJournal(f.input);
    const path = join(f.input.journalRoot, f.paths[0]!);
    await fs.unlink(path);
    await fs.symlink(join(f.input.backupRoot, f.paths[0]!), path);
    await expect(restoreGatewayJournal(f.input)).rejects.toThrow();
    await expect(backupGatewayJournal({ ...f.input, backupRoot: join(f.root, 'other-backup') })).rejects.toThrow();
  });

  it('is a no-op for a legacy schema without the segment table', async () => {
    const f = await fixture(true);
    const before = await fs.readFile(f.input.databasePath);
    await backupGatewayJournal(f.input);
    await restoreGatewayJournal(f.input);
    expect(await fs.readFile(f.input.databasePath)).toEqual(before);
    await expect(fs.stat(f.input.backupRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
