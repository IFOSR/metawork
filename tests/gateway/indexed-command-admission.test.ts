import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientGateway, type ClientGatewayDeps } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { FileCommandAdmissionStore, type CommandAdmissionStore } from '../../src/gateway/command-admission-store.js';
import { SqliteCommandAdmissionStore } from '../../src/storage/command-admission-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const accountId = 'local-default';
const create: GatewayCommandEnvelope = {
  protocolVersion: 2, requestId: 'req_create', idempotencyKey: 'idem_create', connectionId: 'conn_one',
  scope: { kind: 'workspace' }, command: { kind: 'create_conversation', workspaceId: 'workspace_one' },
  clientCapabilities: [],
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'indexed-gateway-admission-'));
  let db = new Database(join(root, 'index.db'));
  runMigrations(db);
  const legacy = new FileCommandAdmissionStore(join(root, 'legacy'));
  cleanups.push(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return {
    legacy,
    async open(restart = false) {
      if (restart) { db.close(); db = new Database(join(root, 'index.db')); }
      const store = new SqliteCommandAdmissionStore(db, accountId);
      await store.initialize(legacy);
      return store;
    },
  };
}
function gateway(store: CommandAdmissionStore, overrides: Partial<ClientGatewayDeps> = {}) {
  return new ClientGateway({
    authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
    accountResolver: { resolve: async () => ({ status: 'authorized', accountId }) },
    conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_one' }) },
    activateAccount: async () => undefined,
    submitToConversation: async () => ({ status: 'accepted' }),
    commandAdmissionStore: store,
    ...overrides,
  });
}

describe('ClientGateway with indexed durable admission', () => {
  it('executes duplicate creation once and replays its terminal receipt after a database restart', async () => {
    const f = await fixture();
    const store = await f.open();
    const createConversation = vi.fn(async () => ({
      status: 'accepted' as const, conversationId: 'conv_created', workspaceId: 'workspace_one',
    }));
    const first = gateway(store, { handleWorkspaceCommand: createConversation });
    const [accepted, duplicate] = await Promise.all([
      first.handle(create, 'local'), first.handle({ ...create, requestId: 'req_concurrent' }, 'local'),
    ]);
    expect(accepted).toMatchObject({ status: 'accepted', conversationId: 'conv_created' });
    expect(duplicate).toMatchObject({ status: 'duplicate', conversationId: 'conv_created' });
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(await store.find(accountId, create.idempotencyKey)).toMatchObject({ state: 'terminal' });
    await first.drain();

    const noLegacy = vi.spyOn(f.legacy, 'exportRetained').mockRejectedValue(new Error('no legacy read after startup import'));
    const restartedStore = await f.open(true);
    const noActivation = vi.fn(async () => { throw new Error('duplicate cannot activate'); });
    const restarted = gateway(restartedStore, { activateAccount: noActivation, handleWorkspaceCommand: createConversation });
    expect(await restarted.handle({ ...create, requestId: 'req_restart' }, 'local')).toEqual({
      ...accepted, requestId: 'req_restart', status: 'duplicate',
    });
    expect(await restarted.handle({
      ...create, requestId: 'req_conflict', command: { kind: 'create_conversation', workspaceId: 'different_workspace' },
    }, 'local')).toMatchObject({ kind: 'conflict', code: 'idempotency_conflict' });
    expect(noActivation).not.toHaveBeenCalled();
    expect(noLegacy).not.toHaveBeenCalled();
    expect(createConversation).toHaveBeenCalledTimes(1);
    await restarted.drain();
  });

  it('replays every imported terminal receipt without re-executing its legacy Gateway command', async () => {
    const f = await fixture();
    const first = gateway(f.legacy, {
      handleWorkspaceCommand: async () => ({ status: 'accepted', conversationId: 'conv_legacy', workspaceId: 'workspace_one' }),
    });
    const accepted = await first.handle(create, 'local');
    await first.drain();
    const store = await f.open();
    const noExecution = vi.fn(async () => { throw new Error('imported terminal must not execute'); });
    const next = gateway(store, { activateAccount: noExecution, handleWorkspaceCommand: noExecution });
    expect(await next.handle({ ...create, requestId: 'req_imported' }, 'local')).toEqual({
      ...accepted, requestId: 'req_imported', status: 'duplicate',
    });
    expect(noExecution).not.toHaveBeenCalled();
    expect(await store.listRecoverable()).toEqual([]);
    await next.drain();
  });

  it('recovers an imported submitted command using its first assigned Conversation', async () => {
    const f = await fixture();
    const request: GatewayCommandEnvelope = {
      ...create, scope: { kind: 'conversation', selection: { mode: 'new', workspaceId: 'workspace_one' } },
      command: { kind: 'user_message', text: 'original', attachments: [] },
    };
    const first = gateway(f.legacy, {
      submitToConversation: async () => ({
        status: 'accepted',
        completion: new Promise<never>(() => undefined),
      }),
    });
    expect(await first.handle(request, 'local')).toMatchObject({ status: 'accepted', conversationId: 'conv_one' });
    const store = await f.open();
    const submit = vi.fn(async (_conversationId: string) => ({ status: 'rejected' as const, reason: 'command_execution_uncertain' }));
    const resolve = vi.fn(async () => { throw new Error('must reuse assigned identity'); });
    const next = gateway(store, { conversationResolver: { resolve }, submitToConversation: submit });
    await next.recover();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toBe('conv_one');
    expect(resolve).not.toHaveBeenCalled();
    expect(await next.handle({ ...request, requestId: 'req_retry' }, 'local'))
      .toMatchObject({ status: 'rejected', conversationId: 'conv_one', reason: 'command_execution_uncertain' });
    expect(submit).toHaveBeenCalledTimes(1);
    await next.drain();
  });
});
