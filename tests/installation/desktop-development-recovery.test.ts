import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { createAccountEventJournal } from '../../src/server/account-event-journal.js';
import { backupGatewayJournal } from '../../src/installation/gateway-journal-backup.js';
import { developmentDatabaseHolders, repairDevelopmentDirectoryJournal, stopDevelopmentDatabaseHolders } from '../../apps/desktop/packaging/development-recovery.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
beforeEach(() => { execute.mockReset().mockResolvedValue({ stdout: '' }); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0)) await fn();
});

const accountId = 'local-default';
const directory = 'workspace_directory_workspace_recovery';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-recovery-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'desktop-development.json'), JSON.stringify({ purpose: 'isolated-desktop-development' }));
  const data = join(root, 'accounts/local-default/data');
  const events = join(root, 'accounts/local-default/gateway/events');
  await mkdir(join(data, 'database-revisions'), { recursive: true });
  // Discovery only needs a revision filename; SQLite fixtures use the public path.
  await writeFile(join(data, 'database-revisions/fixture.db'), '');
  const path = join(data, 'anyfusion.db');
  const db = new Database(path);
  runMigrations(db);
  const runtime = createAccountEventJournal({ db, root: events, accountId, onError: error => { throw error; } });
  const append = async (conversationId: string, kind: 'workspace_activity_changed' | 'final_answer', n: number) => runtime.journal.append({
    protocolVersion: 2, accountId, conversationId, eventId: `event_${n}`, sequence: 0,
    kind, turnId: null, requestId: null, occurredAt: '2026-10-06T00:00:00Z', payload: {},
  });
  await append(directory, 'workspace_activity_changed', 1);
  await append(directory, 'workspace_activity_changed', 2);
  await append('conv_preserved', 'final_answer', 3);
  const rows = db.prepare('SELECT * FROM gateway_journal_segments').all() as Array<{
    conversation_id: string; segment_id: string; last_sequence: number;
  }>;
  const missing = rows.find(row => row.conversation_id === directory && row.last_sequence === 2)!;
  const bodyPath = (row: typeof missing) => join(events, accountId, `${row.conversation_id}.segments`, `${row.segment_id}.json`);
  await runtime.stop();
  db.close();
  await unlink(bodyPath(missing));
  return { root, data, events, path, missing, rows, bodyPath };
}

describe('Desktop development journal recovery', () => {
  it('backs up evidence, expires a directory gap, preserves conversations, and unblocks a strict upgrade backup', async () => {
    const f = await fixture();
    const input = { databasePath: f.path, journalRoot: f.events, backupRoot: join(f.root, 'companion') };
    await expect(backupGatewayJournal(input)).rejects.toMatchObject({ code: 'ENOENT' });
    const before = await readFile(f.path);
    const backup = await repairDevelopmentDirectoryJournal(f.root);
    expect(backup).toBeTruthy();
    const evidence = new Database(join(backup!, 'anyfusion.db'), { readonly: true });
    expect(evidence.prepare('SELECT count(*) AS n FROM gateway_journal_segments').get()).toEqual({ n: 3 });
    evidence.close();
    expect(JSON.parse(await readFile(join(backup!, 'repair.json'), 'utf8')).missing).toHaveLength(1);
    const conversation = f.rows.find(row => row.conversation_id === 'conv_preserved')!;
    const conversationPath = join(accountId, `${conversation.conversation_id}.segments`, `${conversation.segment_id}.json`);
    expect(await readFile(join(backup!, 'gateway-events', conversationPath))).toEqual(await readFile(f.bodyPath(conversation)));
    expect(await readFile(f.path)).not.toEqual(before);
    const db = new Database(f.path);
    const runtime = createAccountEventJournal({ db, root: f.events, accountId, onError: error => { throw error; } });
    try {
      expect(await runtime.journal.resume(accountId, directory, 1)).toMatchObject({
        lastSequence: 2, replayFloor: 2, deltas: [], cursorReset: { reason: 'cursor_expired', sequence: 2 },
      });
      expect((await runtime.journal.replay(accountId, 'conv_preserved')).deltas).toHaveLength(1);
      await runtime.journal.append({ protocolVersion: 2, accountId, conversationId: directory,
        eventId: 'event_after', sequence: 0, kind: 'workspace_activity_changed', turnId: null,
        requestId: null, occurredAt: '2026-10-06T00:00:01Z', payload: {} });
      expect((await runtime.journal.resume(accountId, directory, 2)).deltas[0]?.sequence).toBe(3);
    } finally { await runtime.stop(); db.close(); }
    await backupGatewayJournal(input);
    expect(await repairDevelopmentDirectoryJournal(f.root)).toBeNull();
  });

  it('refuses any missing Conversation body before mutating the directory index', async () => {
    const f = await fixture();
    await unlink(f.bodyPath(f.rows.find(row => row.conversation_id === 'conv_preserved')!));
    const before = await readFile(f.path);
    await expect(repairDevelopmentDirectoryJournal(f.root)).rejects.toThrow('Conversation journal body is missing');
    expect(await readFile(f.path)).toEqual(before);
    await expect(readdir(join(f.data, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses unmarked installations', async () => {
    const f = await fixture();
    await unlink(join(f.root, 'desktop-development.json'));
    await expect(repairDevelopmentDirectoryJournal(f.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects old database holders without runtime.lock and refuses repair while one is alive', async () => {
    const f = await fixture();
    execute.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args.includes('cwd') ? `p4242\nfcwd\nn${f.root}\n` : 'p4242\ncnode\n',
    }));
    expect(await developmentDatabaseHolders(f.root)).toEqual([4242]);
    const before = await readFile(f.path);
    await expect(repairDevelopmentDirectoryJournal(f.root)).rejects.toThrow('Stop all development Servers');
    expect(await readFile(f.path)).toEqual(before);
  });

  it('does not approve an unrelated process for automatic shutdown', async () => {
    const f = await fixture();
    execute.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args.includes('cwd') ? 'p4242\nfcwd\nn/somewhere-else\n' : 'p4242\ncnode\n',
    }));
    await expect(developmentDatabaseHolders(f.root)).rejects.toThrow('unverified process 4242');
  });

  it('waits for old exit hooks to finish before permitting an upgrade', async () => {
    const f = await fixture();
    let exited = false;
    execute.mockImplementation(async (_command: string, args: string[]) => ({ stdout: exited ? ''
      : args.includes('cwd') ? `p4242\nfcwd\nn${f.root}\n` : 'p4242\ncnode\n' }));
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(4242);
      signals.push(signal);
      if (signals.length >= 3) {
        exited = true;
        throw Object.assign(new Error('exited'), { code: 'ESRCH' });
      }
      return true;
    });
    await stopDevelopmentDatabaseHolders(f.root);
    expect(signals).toEqual(['SIGTERM', 0, 0]);
  });

  it('stops without touching the installation when process termination is denied', async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    execute.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args.includes('cwd') ? `p4242\nfcwd\nn${f.root}\n` : 'p4242\ncnode\n',
    }));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    await expect(stopDevelopmentDatabaseHolders(f.root)).rejects.toThrow('无法停止旧开发服务 PID 4242');
    expect(await readFile(f.path)).toEqual(before);
  });
});
