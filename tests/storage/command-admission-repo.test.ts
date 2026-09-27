import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileCommandAdmissionStore, type CommandAdmissionStore,
  type ReserveCommandAdmissionInput, type StoredCommandAdmission,
} from '../../src/gateway/command-admission-store.js';
import type { CommandReceipt } from '../../src/gateway/command-admission.js';
import { SqliteCommandAdmissionStore } from '../../src/storage/command-admission-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const accountId = 'local-default';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const input: ReserveCommandAdmissionInput = {
  accountId, idempotencyKey: 'idem_one', fingerprint: 'fp_one', requestId: 'req_one', connectionId: 'conn_one',
  principalId: 'local:owner', scope: { kind: 'conversation', selection: { mode: 'new', workspaceId: 'workspace_one' } },
  command: { kind: 'user_message', text: 'hello', attachments: [] }, conversationId: null,
  now: '2026-09-27T00:00:00Z',
};
const receipt: CommandReceipt = {
  requestId: input.requestId, idempotencyKey: input.idempotencyKey,
  status: 'accepted', conversationId: 'conv_one', workspaceId: 'workspace_one',
};
function record(idempotencyKey: string, state: StoredCommandAdmission['state']): StoredCommandAdmission {
  return {
    ...input, idempotencyKey, state, receipt: state === 'terminal' ? { ...receipt, idempotencyKey } : null,
    uncertaintyReason: state === 'uncertain' ? 'uncertain' : null, createdAt: input.now, updatedAt: input.now,
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'admission-repo-'));
  const db = new Database(join(root, 'index.db'));
  runMigrations(db);
  cleanups.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const legacy = new FileCommandAdmissionStore(join(root, 'legacy'));
  const store = new SqliteCommandAdmissionStore(db, accountId);
  return { root, db, legacy, store };
}
const emptySource = () => ({ exportRetained: vi.fn(async () => [] as StoredCommandAdmission[]) });

describe('SqliteCommandAdmissionStore contract', () => {
  it('matches FileCommandAdmissionStore transitions, conflicts and terminal monotonicity exactly', async () => {
    const f = await fixture();
    await f.store.initialize(emptySource());
    const operations: Array<(store: CommandAdmissionStore) => Promise<unknown>> = [
      store => store.reserve(input),
      store => store.reserve({ ...input, fingerprint: 'conflict', requestId: 'new-request' }),
      store => store.assignConversation(accountId, input.idempotencyKey, input.fingerprint, 'conv_one', 't1'),
      store => store.assignConversation(accountId, input.idempotencyKey, input.fingerprint, 'conv_other', 't2'),
      store => store.markSubmitted(accountId, input.idempotencyKey, input.fingerprint, 't3'),
      store => store.markUncertain(accountId, input.idempotencyKey, input.fingerprint, 'network', 't4'),
      store => store.markSubmitted(accountId, input.idempotencyKey, input.fingerprint, 't5'),
      store => store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, receipt, 't6'),
      store => store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, { ...receipt, status: 'rejected' }, 't7'),
      store => store.markSubmitted(accountId, input.idempotencyKey, input.fingerprint, 't8'),
      store => store.markUncertain(accountId, input.idempotencyKey, input.fingerprint, 'late failure', 't9'),
      store => store.reserve(input),
    ];
    for (const operation of operations) {
      expect(await operation(f.store)).toEqual(await operation(f.legacy));
      expect(await f.store.find(accountId, input.idempotencyKey)).toEqual(await f.legacy.find(accountId, input.idempotencyKey));
      expect(await f.store.listRecoverable()).toEqual(await f.legacy.listRecoverable());
    }
    for (const store of [f.store, f.legacy]) {
      await expect(store.assignConversation(accountId, input.idempotencyKey, 'wrong', 'conv_x', 'late'))
        .rejects.toThrow('command admission fingerprint conflict');
      await expect(store.markSubmitted(accountId, input.idempotencyKey, 'wrong', 'late'))
        .rejects.toThrow('command admission fingerprint conflict');
      await expect(store.markTerminal(accountId, input.idempotencyKey, 'wrong', receipt, 'late'))
        .rejects.toThrow('command admission fingerprint conflict');
      await expect(store.markUncertain(accountId, input.idempotencyKey, 'wrong', 'reason', 'late'))
        .rejects.toThrow('command admission fingerprint conflict');
      await expect(store.markSubmitted(accountId, 'missing', input.fingerprint, 'late'))
        .rejects.toThrow('command admission is not reserved');
    }
  });

  it('preserves first assignment even when a terminal record had no Conversation identity', async () => {
    const f = await fixture();
    await f.store.initialize(emptySource());
    for (const store of [f.legacy, f.store]) {
      await store.reserve(input);
      await store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, { ...receipt, conversationId: null }, 'terminal');
      await store.assignConversation(accountId, input.idempotencyKey, input.fingerprint, 'conv_first', 'assigned');
      await store.assignConversation(accountId, input.idempotencyKey, input.fingerprint, 'conv_second', 'ignored');
    }
    expect(await f.store.find(accountId, input.idempotencyKey)).toEqual(await f.legacy.find(accountId, input.idempotencyKey));
    expect(await f.store.find(accountId, input.idempotencyKey)).toMatchObject({
      state: 'terminal', conversationId: 'conv_first', updatedAt: 'assigned', receipt: { conversationId: null },
    });
  });

  it('isolates account/key lookups and recovery, including the same key in another account', async () => {
    const f = await fixture();
    const other = new SqliteCommandAdmissionStore(f.db, 'account-other');
    await f.store.initialize(emptySource());
    await other.initialize(emptySource());
    await f.store.reserve(input);
    await other.reserve({ ...input, accountId: 'account-other', fingerprint: 'other' });
    expect(await f.store.find('account-other', input.idempotencyKey)).toBeNull();
    expect(await other.find('account-other', input.idempotencyKey)).toMatchObject({ fingerprint: 'other' });
    expect(await f.store.listRecoverable()).toEqual([await f.store.find(accountId, input.idempotencyKey)]);
    await expect(f.store.reserve({ ...input, accountId: 'account-other' })).rejects.toThrow('account');
  });

  it('keeps the first reservation, assignment and terminal receipt across competing connections', async () => {
    const f = await fixture();
    await f.store.initialize(emptySource());
    const otherDb = new Database(join(f.root, 'index.db'));
    cleanups.push(async () => { otherDb.close(); });
    const other = new SqliteCommandAdmissionStore(otherDb, accountId);
    await other.initialize({ exportRetained: async () => { throw new Error('already imported'); } });
    const reserved = await Promise.all([
      f.store.reserve(input), other.reserve({ ...input, fingerprint: 'conflict' }),
    ]);
    expect(reserved[0]).toEqual(reserved[1]);
    const assigned = await Promise.all([
      f.store.assignConversation(accountId, input.idempotencyKey, input.fingerprint, 'conv_first', 't1'),
      other.assignConversation(accountId, input.idempotencyKey, input.fingerprint, 'conv_second', 't2'),
    ]);
    expect(assigned.map(item => item.conversationId)).toEqual(['conv_first', 'conv_first']);
    const terminal = await Promise.all([
      other.markTerminal(accountId, input.idempotencyKey, input.fingerprint, receipt, 't3'),
      f.store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, { ...receipt, status: 'rejected' }, 't4'),
    ]);
    expect(terminal[0]).toEqual(terminal[1]);
  });

  it('does not retain caller mutation of inputs, receipts or returned values', async () => {
    const f = await fixture();
    await f.store.initialize(emptySource());
    const reserved = await f.store.reserve(structuredClone(input));
    (reserved.command as { text: string }).text = 'mutated';
    expect((await f.store.find(accountId, input.idempotencyKey))?.command).toEqual(input.command);
    const mutableReceipt = structuredClone(receipt);
    await f.store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, mutableReceipt, 't1');
    (mutableReceipt as { status: string }).status = 'rejected';
    expect((await f.store.find(accountId, input.idempotencyKey))?.receipt).toEqual(receipt);
  });

  it('point reads/transitions and recoverable SQL never hydrate unrelated terminal bodies', async () => {
    const f = await fixture();
    const source = emptySource();
    await f.store.initialize(source);
    const insert = f.db.prepare(`INSERT INTO gateway_command_admissions
      (account_id, idempotency_key, state, body_json) VALUES (?, ?, ?, ?)`);
    f.db.transaction(() => {
      for (let n = 0; n < 4_000; n += 1) insert.run(accountId, `unrelated_${n}`, 'terminal', '{not-json');
      insert.run('account-other', 'unrelated_pending', 'pending', '{not-json');
    })();
    await f.store.reserve(input);
    await f.store.reserve({ ...input, idempotencyKey: 'earlier', now: '2000' });
    await f.store.markSubmitted(accountId, input.idempotencyKey, input.fingerprint, 'submitted');
    expect(await f.store.find(accountId, input.idempotencyKey)).toMatchObject({ state: 'submitted' });
    expect((await f.store.listRecoverable()).map(item => item.idempotencyKey)).toEqual(['earlier', input.idempotencyKey]);
    expect(await f.store.find(accountId, 'missing')).toBeNull();
    await expect(f.store.find(accountId, 'unrelated_1')).rejects.toThrow();
    const partialIndexes = f.db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'gateway_command_admissions' AND sql LIKE '%WHERE%'`).all() as { name: string }[];
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT idempotency_key, state, body_json
      FROM gateway_command_admissions WHERE account_id = ? AND state != 'terminal'`).all(accountId) as { detail: string }[];
    expect(partialIndexes.some(index => plan.some(row => row.detail.includes(index.name)))).toBe(true);
    const pointPlan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT idempotency_key, state, body_json
      FROM gateway_command_admissions WHERE account_id = ? AND idempotency_key = ?`)
      .all(accountId, input.idempotencyKey) as { detail: string }[];
    expect(pointPlan.map(row => row.detail).join(' ')).toContain('(account_id=? AND idempotency_key=?)');
    expect(source.exportRetained).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed transition without exposing a split state/body pair', async () => {
    const f = await fixture();
    await f.store.initialize(emptySource());
    const before = await f.store.reserve(input);
    f.db.exec(`CREATE TEMP TRIGGER fail_admission_transition AFTER UPDATE ON gateway_command_admissions
      BEGIN SELECT RAISE(ABORT, 'injected transition failure'); END`);
    await expect(f.store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, receipt, 'failed'))
      .rejects.toThrow('injected transition failure');
    expect(await f.store.find(accountId, input.idempotencyKey)).toEqual(before);
    expect(await f.store.listRecoverable()).toEqual([before]);
    f.db.exec('DROP TRIGGER fail_admission_transition');
    await f.store.markTerminal(accountId, input.idempotencyKey, input.fingerprint, receipt, 'committed');
    expect(await f.store.listRecoverable()).toEqual([]);
  });
});

describe('command admission startup import', () => {
  it('requires initialization before serving or mutating admissions', async () => {
    const f = await fixture();
    await expect(f.store.reserve(input)).rejects.toThrow('initialized');
    await expect(f.store.find(accountId, input.idempotencyKey)).rejects.toThrow('initialized');
    await expect(f.store.listRecoverable()).rejects.toThrow('initialized');
  });

  it('imports all states atomically once, never rewrites legacy JSON, and skips legacy on reopen', async () => {
    const f = await fixture();
    await f.legacy.reserve(input);
    await f.legacy.markTerminal(accountId, input.idempotencyKey, input.fingerprint, receipt, 'terminal');
    const entries = [await f.legacy.find(accountId, input.idempotencyKey)];
    for (const state of ['pending', 'submitted', 'uncertain'] as const) {
      const value = { ...input, idempotencyKey: state };
      await f.legacy.reserve(value);
      if (state === 'submitted') await f.legacy.markSubmitted(accountId, state, input.fingerprint, state);
      if (state === 'uncertain') await f.legacy.markUncertain(accountId, state, input.fingerprint, 'reason', state);
      entries.push(await f.legacy.find(accountId, state));
    }
    const path = join(f.root, 'legacy', `${accountId}.json`);
    const before = await readFile(path, 'utf8');
    const exportRetained = vi.spyOn(f.legacy, 'exportRetained');
    await Promise.all([f.store.initialize(f.legacy), f.store.initialize(f.legacy)]);
    expect(exportRetained).toHaveBeenCalledTimes(1);
    for (const entry of entries) expect(await f.store.find(accountId, entry!.idempotencyKey)).toEqual(entry);
    await f.store.markSubmitted(accountId, 'pending', input.fingerprint, 'new');
    expect(await readFile(path, 'utf8')).toBe(before);
    const reopenedDb = new Database(join(f.root, 'index.db'));
    cleanups.push(async () => { reopenedDb.close(); });
    const reopened = new SqliteCommandAdmissionStore(reopenedDb, accountId);
    await reopened.initialize({ exportRetained: async () => { throw new Error('must not read legacy'); } });
    expect(await reopened.find(accountId, input.idempotencyKey)).toEqual(entries[0]);
    expect(await reopened.find(accountId, 'pending')).toMatchObject({ state: 'submitted' });
  });

  it('rolls back all rows if the import-marker commit fails, then safely retries', async () => {
    const f = await fixture();
    const admissions = [record('terminal', 'terminal'), record('pending', 'pending')];
    const source = { exportRetained: vi.fn(async () => admissions) };
    f.db.exec(`CREATE TEMP TRIGGER fail_admission_import BEFORE INSERT ON gateway_command_admission_imports
      BEGIN SELECT RAISE(ABORT, 'injected import failure'); END`);
    await expect(f.store.initialize(source)).rejects.toThrow('injected import failure');
    expect(f.db.prepare('SELECT * FROM gateway_command_admissions').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([]);
    await expect(f.store.reserve(input)).rejects.toThrow('initialized');
    f.db.exec('DROP TRIGGER fail_admission_import');
    await f.store.initialize(source);
    expect(await f.store.find(accountId, 'terminal')).toEqual(admissions[0]);
    expect(await f.store.listRecoverable()).toEqual([admissions[1]]);
  });

  it('does not overwrite newer indexed admissions after a concurrent importer wins', async () => {
    const f = await fixture();
    const retained = record(input.idempotencyKey, 'pending');
    let release!: (rows: StoredCommandAdmission[]) => void;
    const delayed = new Promise<StoredCommandAdmission[]>(resolve => { release = resolve; });
    const firstImport = f.store.initialize({ exportRetained: async () => delayed });
    const otherDb = new Database(join(f.root, 'index.db'));
    cleanups.push(async () => { otherDb.close(); });
    const other = new SqliteCommandAdmissionStore(otherDb, accountId);
    await other.initialize({ exportRetained: async () => [retained] });
    const terminal = await other.markTerminal(accountId, input.idempotencyKey, input.fingerprint, receipt, 'newer');
    release([retained]);
    await firstImport;
    expect(await f.store.find(accountId, input.idempotencyKey)).toEqual(terminal);
    expect(await f.store.listRecoverable()).toEqual([]);
  });

  it.each(['fingerprint', 'state', 'receipt'])('rejects conflicting duplicate legacy %s without an import marker', async field => {
    const f = await fixture();
    const first = record('same', 'terminal');
    const conflict = {
      ...first,
      ...(field === 'fingerprint' ? { fingerprint: 'other' }
        : field === 'state' ? { state: 'pending' as const }
        : { receipt: { ...first.receipt!, status: 'rejected' as const } }),
    };
    await expect(f.store.initialize({ exportRetained: async () => [first, conflict] }))
      .rejects.toThrow('conflict');
    expect(f.db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM gateway_command_admissions').all()).toEqual([]);
  });

  it('deduplicates identical legacy records but rejects collisions with different indexed evidence', async () => {
    const f = await fixture();
    const first = record('same', 'terminal');
    f.db.prepare(`INSERT INTO gateway_command_admissions VALUES (?, ?, ?, ?)`)
      .run(accountId, first.idempotencyKey, first.state, JSON.stringify({ ...first, fingerprint: 'different' }));
    await expect(f.store.initialize({ exportRetained: async () => [first, structuredClone(first)] }))
      .rejects.toThrow('conflict');
    expect(f.db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([]);
    f.db.prepare('DELETE FROM gateway_command_admissions').run();
    await f.store.initialize({ exportRetained: async () => [first, structuredClone(first)] });
    expect(f.db.prepare('SELECT count(*) AS n FROM gateway_command_admissions').get()).toEqual({ n: 1 });
  });

  it('fails closed for corrupt legacy JSON and foreign records, without marking them imported', async () => {
    const f = await fixture();
    await f.legacy.reserve(input);
    await writeFile(join(f.root, 'legacy', `${accountId}.json`), '{broken');
    await expect(f.store.initialize(f.legacy)).rejects.toThrow();
    await expect(f.store.initialize({ exportRetained: async () => [{ ...record('foreign', 'terminal'), accountId: 'other' }] }))
      .rejects.toThrow('Invalid');
    expect(f.db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([]);
  });

  it.each([
    { name: 'null', value: null },
    { name: 'missing', value: undefined },
    { name: 'empty object', value: {} },
    { name: 'array', value: [] },
    { name: 'invalid status', value: { ...receipt, status: 'completed' } },
    { name: 'missing status', value: { ...receipt, status: undefined } },
    { name: 'wrong request identity', value: { ...receipt, requestId: 'req_other' } },
    { name: 'missing request identity', value: { ...receipt, requestId: undefined } },
    { name: 'wrong idempotency identity', value: { ...receipt, idempotencyKey: 'idem_other' } },
    { name: 'missing idempotency identity', value: { ...receipt, idempotencyKey: undefined } },
    { name: 'missing Conversation field', value: { ...receipt, conversationId: undefined } },
    { name: 'invalid Conversation field', value: { ...receipt, conversationId: 42 } },
  ])('rejects a terminal receipt with $name before deduplication or import commit', async ({ value }) => {
    const f = await fixture();
    const malformed = {
      ...record(input.idempotencyKey, 'terminal'), receipt: value,
    } as unknown as StoredCommandAdmission;
    await expect(f.store.initialize({
      exportRetained: async () => [record('valid_before_bad', 'pending'), malformed, structuredClone(malformed)],
    })).rejects.toThrow('Invalid command admission import');
    expect(f.db.prepare('SELECT * FROM gateway_command_admissions').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([]);
    await expect(f.store.reserve(input)).rejects.toThrow('not initialized');
    await f.store.initialize({ exportRetained: async () => [record(input.idempotencyKey, 'terminal')] });
    expect(await f.store.find(accountId, input.idempotencyKey)).toEqual(record(input.idempotencyKey, 'terminal'));
  });

  it('preserves supported terminal receipt variants and nonterminal null receipts exactly', async () => {
    const f = await fixture();
    const admissions: StoredCommandAdmission[] = ['accepted', 'duplicate', 'rejected'].map(status => ({
      ...record(status, 'terminal'),
      scope: { kind: 'workspace' },
      command: { kind: 'create_conversation', workspaceId: 'workspace_one' },
      conversationId: null,
      receipt: {
        requestId: input.requestId, idempotencyKey: status,
        status: status as CommandReceipt['status'], conversationId: status === 'rejected' ? null : 'conv_created',
        workspaceId: null, reason: 'historical reason', legacyMetadata: { retained: ['exactly'] },
      } as CommandReceipt,
    }));
    admissions.push({
      ...record('assigned_after_terminal', 'terminal'), conversationId: 'conv_later',
      receipt: { requestId: input.requestId, idempotencyKey: 'assigned_after_terminal', status: 'rejected', conversationId: null },
    });
    admissions.push(...(['pending', 'submitted', 'uncertain'] as const).map(state => record(state, state)));
    const original = structuredClone(admissions);
    await f.store.initialize({ exportRetained: async () => admissions });
    for (const admission of original) {
      expect(await f.store.find(accountId, admission.idempotencyKey)).toEqual(admission);
    }
    expect(admissions).toEqual(original);
  });

  it.each(['accepted', 'duplicate', 'rejected'] as const)('imports legitimate v1 %s receipts unchanged', async status => {
    const f = await fixture();
    await f.legacy.reserve(input);
    const { scope: _scope, connectionId: _connection, ...legacyFields } = record(input.idempotencyKey, 'terminal');
    const oldReceipt = {
      requestId: input.requestId, idempotencyKey: input.idempotencyKey, status,
      conversationId: 'conv_legacy', legacyDetails: { retained: true },
    };
    const contents = JSON.stringify({
      version: 1,
      admissions: [{
        ...legacyFields, conversation: { mode: 'new' },
        conversationId: 'conv_legacy', receipt: oldReceipt,
      }],
    }, null, 4);
    const path = join(f.root, 'legacy', `${accountId}.json`);
    await writeFile(path, contents);
    const exported = await f.legacy.exportRetained(accountId);
    await f.store.initialize(f.legacy);
    expect(await f.store.find(accountId, input.idempotencyKey)).toEqual(exported[0]);
    expect((await f.store.find(accountId, input.idempotencyKey))?.receipt).toEqual(oldReceipt);
    expect(await readFile(path, 'utf8')).toBe(contents);
  });

  it.each([1, 2])('does not mark a malformed v%s terminal file imported or rewrite its bytes', async version => {
    const f = await fixture();
    await f.legacy.reserve(input);
    const contents = JSON.stringify({
      version,
      admissions: [{
        ...record(input.idempotencyKey, 'terminal'),
        conversation: { mode: 'attach', conversationId: 'conv_one' },
        conversationId: 'conv_one', receipt: null,
      }],
    });
    const path = join(f.root, 'legacy', `${accountId}.json`);
    await writeFile(path, contents);
    await expect(f.store.initialize(f.legacy)).rejects.toThrow('Invalid command admission import');
    expect(f.db.prepare('SELECT * FROM gateway_command_admissions').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM gateway_command_admission_imports').all()).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe(contents);
  });
});
