import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCommandAdmissionStore } from '../../src/gateway/command-admission-store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const record = {
  accountId: 'local-default', idempotencyKey: 'idem_one', fingerprint: 'fingerprint_one',
  requestId: 'req_one', connectionId: 'conn_one', principalId: 'local:owner',
  scope: { kind: 'conversation', selection: { mode: 'attach', conversationId: 'conv_one' } },
  command: { kind: 'user_message', text: 'hello', attachments: [] }, conversationId: 'conv_one',
  state: 'terminal', receipt: {
    requestId: 'req_one', idempotencyKey: 'idem_one', status: 'accepted', conversationId: 'conv_one',
  },
  uncertaintyReason: null, createdAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:01Z',
};
async function fixture(contents?: string) {
  const root = await mkdtemp(join(tmpdir(), 'admission-export-'));
  roots.push(root);
  const path = join(root, 'local-default.json');
  if (contents !== undefined) await writeFile(path, contents);
  return { store: new FileCommandAdmissionStore(root), path };
}

describe('read-only command admission migration export', () => {
  it('exports every v2 state without rewriting the source', async () => {
    const admissions = ['pending', 'submitted', 'uncertain', 'terminal'].map(state => ({
      ...record, state, idempotencyKey: state,
    }));
    const contents = JSON.stringify({ version: 2, admissions }, null, 4);
    const f = await fixture(contents);
    expect(await f.store.exportRetained('local-default')).toEqual(admissions);
    expect(await readFile(f.path, 'utf8')).toBe(contents);
  });

  it('normalizes safe v1 terminal receipts in memory only', async () => {
    const { scope: _scope, connectionId: _connection, ...rest } = record;
    const contents = JSON.stringify({ version: 1, admissions: [{ ...rest, conversation: { mode: 'new' } }] });
    const f = await fixture(contents);
    expect(await f.store.exportRetained('local-default')).toEqual([{
      ...record, connectionId: 'legacy-req_one',
    }]);
    expect(await readFile(f.path, 'utf8')).toBe(contents);
  });

  it.each(['pending', 'submitted', 'uncertain'])('rejects unsafe v1 %s without rewriting it', async state => {
    const contents = JSON.stringify({
      version: 1, admissions: [{ ...record, state, conversation: { mode: 'new' } }],
    });
    const f = await fixture(contents);
    await expect(f.store.exportRetained('local-default')).rejects.toThrow('Unsafe nonterminal v1');
    expect(await readFile(f.path, 'utf8')).toBe(contents);
  });

  it.each([
    '{broken',
    JSON.stringify({ version: 2, admissions: [{}] }),
    JSON.stringify({ version: 2, admissions: [{ ...record, accountId: 'another-account' }] }),
  ])('fails closed for corrupt or cross-account legacy data', async contents => {
    const f = await fixture(contents);
    await expect(f.store.exportRetained('local-default')).rejects.toThrow();
    expect(await readFile(f.path, 'utf8')).toBe(contents);
  });

  it('treats a missing legacy file as empty', async () => {
    const f = await fixture();
    expect(await f.store.exportRetained('local-default')).toEqual([]);
    await expect(readFile(f.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
