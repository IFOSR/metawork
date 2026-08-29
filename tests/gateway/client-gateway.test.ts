import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import {
  MAX_GATEWAY_COMMAND_TEXT_BYTES,
  type GatewayCommandEnvelope,
} from '../../src/gateway/client-protocol.js';
import {
  FileCommandAdmissionStore,
  MemoryCommandAdmissionStore,
} from '../../src/gateway/command-admission-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const envelope: GatewayCommandEnvelope = {
  protocolVersion: 2,
  requestId: 'req_1',
  idempotencyKey: 'idem_1',
  connectionId: 'conn_1',
  scope: { kind: 'conversation', selection: { mode: 'new', workspaceId: 'workspace_repo' } },
  command: { kind: 'user_message', text: 'hello', attachments: [] },
  clientCapabilities: [],
};

describe('ClientGateway', () => {
  it('returns an authentication error when authentication fails', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => null },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });

    const result = await gateway.handle(envelope, 'web');
    expect(result).toMatchObject({ kind: 'authentication', requestId: 'req_1' });
  });

  it('returns an authorization error when the account is denied', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'denied', reason: 'no mapping' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });

    const result = await gateway.handle(envelope, 'local');
    expect(result).toMatchObject({ kind: 'authorization', requestId: 'req_1' });
  });

  it('rejects an oversized command before authentication or durable admission', async () => {
    let authenticated = false;
    const store = new MemoryCommandAdmissionStore();
    const gateway = new ClientGateway({
      authenticator: {
        authenticate: async () => {
          authenticated = true;
          return { kind: 'local', id: 'local-installation' };
        },
      },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
      commandAdmissionStore: store,
    });

    const result = await gateway.handle({
      ...envelope,
      command: {
        kind: 'user_message',
        text: 'x'.repeat(MAX_GATEWAY_COMMAND_TEXT_BYTES + 1),
        attachments: [],
      },
    }, 'local');

    expect(result).toMatchObject({
      kind: 'invalid_command',
      code: 'invalid_gateway_command',
      requestId: 'req_1',
    });
    expect(authenticated).toBe(false);
    await expect(store.listRecoverable()).resolves.toEqual([]);
  });

  it('admits a valid command end to end', async () => {
    const activated: string[] = [];
    const submitted: string[] = [];
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async accountId => { activated.push(accountId); },
      submitToConversation: async conversationId => {
        submitted.push(conversationId);
        return { status: 'accepted' };
      },
    });

    const result = await gateway.handle(envelope, 'local');
    expect(result).toMatchObject({ status: 'accepted', conversationId: 'conv_1' });
    expect(activated).toEqual(['local-default']);
    expect(submitted).toEqual(['conv_1']);
  });

  it('propagates the authenticated transport origin into the Conversation mailbox', async () => {
    const origins: Array<{ connectionId: string; surface: string }> = [];
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async (_conversationId, _requestId, _idempotencyKey, _command, _principalId, origin) => {
        if (origin) origins.push(origin);
        return { status: 'accepted' };
      },
    });

    await gateway.handle({
      ...envelope,
      requestId: 'req_web',
      idempotencyKey: 'idem_web',
      connectionId: 'web_a',
    }, 'web');
    await gateway.handle({
      ...envelope,
      requestId: 'req_feishu',
      idempotencyKey: 'idem_feishu',
      connectionId: 'feishu_b',
    }, 'feishu');
    await gateway.handle({
      ...envelope,
      requestId: 'req_tui',
      idempotencyKey: 'idem_tui',
      connectionId: 'tui_c',
    }, 'local');

    expect(origins).toEqual([
      { connectionId: 'web_a', surface: 'web' },
      { connectionId: 'feishu_b', surface: 'feishu' },
      { connectionId: 'tui_c', surface: 'local' },
    ]);
  });

  it('handles Workspace selection outside the Conversation mailbox', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => { throw new Error('must not submit'); },
      handleWorkspaceCommand: async command => ({
        status: command.kind === 'select_workspace' ? 'accepted' : 'rejected',
      }),
    });
    await expect(gateway.handle(workspaceInitializationEnvelope(), 'local'))
      .resolves.toMatchObject({ status: 'accepted', conversationId: null });
  });

  it('returns the structured Workspace rejection when automatic initialization fails', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => { throw new Error('must not submit'); },
      handleWorkspaceCommand: async () => ({
        status: 'rejected',
        reason: 'workspace_unauthorized',
      }),
    });

    await expect(gateway.handle(workspaceInitializationEnvelope(), 'local'))
      .resolves.toMatchObject({
        status: 'rejected',
        conversationId: null,
        reason: 'workspace_unauthorized',
      });
  });

  it('keeps ordinary semantic commands asynchronously accepted', async () => {
    const completion = deferredCompletion();
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({
        status: 'accepted',
        completion: completion.promise,
      }),
    });

    await expect(gateway.handle(envelope, 'local')).resolves.toMatchObject({
      status: 'accepted',
      conversationId: 'conv_1',
    });
    completion.resolve({ status: 'completed' });
  });

  it('returns duplicate for a repeated idempotency key', async () => {
    let submits = 0;
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => { submits += 1; return { status: 'accepted' }; },
    });

    await gateway.handle(envelope, 'local');
    const duplicate = await gateway.handle(envelope, 'local');

    expect(duplicate).toMatchObject({ status: 'duplicate' });
    expect(submits).toBe(1);
  });

  it('single-flights a concurrent new-Conversation retry before resolving the Conversation', async () => {
    let resolves = 0;
    let submits = 0;
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: {
        resolve: async () => {
          resolves += 1;
          return { status: 'created', conversationId: 'conv_1' };
        },
      },
      activateAccount: async () => undefined,
      submitToConversation: async () => {
        submits += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { status: 'accepted' };
      },
    });

    const [first, duplicate] = await Promise.all([
      gateway.handle(envelope, 'local'),
      gateway.handle({ ...envelope, requestId: 'req_2' }, 'local'),
    ]);

    expect(first).toMatchObject({ status: 'accepted', conversationId: 'conv_1' });
    expect(duplicate).toMatchObject({ status: 'duplicate', conversationId: 'conv_1' });
    expect(resolves).toBe(1);
    expect(submits).toBe(1);
  });

  it('replays a durable receipt before activating or resolving after restart', async () => {
    const store = new MemoryCommandAdmissionStore();
    const build = (failIfCalled: () => never) => new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: {
        resolve: async () => ({ status: 'created', conversationId: failIfCalled() }),
      },
      activateAccount: async () => { failIfCalled(); },
      submitToConversation: async () => {
        failIfCalled();
      },
      commandAdmissionStore: store,
    });
    const first = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
      commandAdmissionStore: store,
    });
    await first.handle(envelope, 'local');

    const restarted = build(() => {
      throw new Error('must not activate or resolve');
    });
    await expect(restarted.handle({ ...envelope, requestId: 'req_2' }, 'local'))
      .resolves.toMatchObject({
        status: 'duplicate',
        conversationId: 'conv_1',
      });
  });

  it('rejects an idempotency key reused with a different payload', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });
    await gateway.handle(envelope, 'local');

    const conflict = await gateway.handle({
      ...envelope,
      requestId: 'req_2',
      command: { kind: 'user_message', text: 'different', attachments: [] },
    }, 'local');

    expect(conflict).toMatchObject({
      kind: 'conflict',
      code: 'idempotency_conflict',
      requestId: 'req_2',
    });
  });

  it('recovers a persisted submitted command with one stable new-Conversation identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-client-gateway-restart-'));
    roots.push(root);
    const firstStore = new FileCommandAdmissionStore(root);
    const terminal = new Promise<void>(() => undefined);
    let resolves = 0;
    const first = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: {
        resolve: async () => {
          resolves += 1;
          return { status: 'created', conversationId: 'conv_stable' };
        },
      },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({
        status: 'accepted',
        completion: terminal.then(() => ({ status: 'completed' as const })),
      }),
      commandAdmissionStore: firstStore,
    });

    const accepted = await first.handle(envelope, 'local');
    expect(accepted).toMatchObject({
      status: 'accepted',
      conversationId: 'conv_stable',
    });
    const conversationId = 'conversationId' in accepted ? accepted.conversationId : null;
    await expect(firstStore.find('local-default', 'idem_1')).resolves.toMatchObject({
      state: 'submitted',
      conversationId: 'conv_stable',
    });

    let recoverySubmits = 0;
    const restartedStore = new FileCommandAdmissionStore(root);
    const restarted = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: {
        resolve: async () => {
          throw new Error('recovery must reuse the durable Conversation identity');
        },
      },
      activateAccount: async () => undefined,
      submitToConversation: async recoveredConversationId => {
        recoverySubmits += 1;
        expect(recoveredConversationId).toBe(conversationId);
        return {
          status: 'rejected',
          reason: 'command_execution_uncertain',
          completion: Promise.resolve({
            status: 'failed' as const,
            reason: 'command_execution_uncertain',
          }),
        };
      },
      commandAdmissionStore: restartedStore,
    });

    await restarted.recover();
    expect(resolves).toBe(1);
    expect(recoverySubmits).toBe(1);
    await expect(restartedStore.find('local-default', 'idem_1')).resolves.toMatchObject({
      state: 'terminal',
      receipt: {
        status: 'rejected',
        conversationId,
        reason: 'command_execution_uncertain',
      },
    });

    const replay = await restarted.handle({ ...envelope, requestId: 'req_retry' }, 'local');
    expect(replay).toMatchObject({
      status: 'rejected',
      conversationId,
      reason: 'command_execution_uncertain',
    });
    expect(recoverySubmits).toBe(1);
  });

  it('closes command admission and drains a handle already in progress', async () => {
    let releaseAuthentication: (() => void) | null = null;
    const authenticationGate = new Promise<void>(resolve => {
      releaseAuthentication = resolve;
    });
    const gateway = new ClientGateway({
      authenticator: {
        authenticate: async () => {
          await authenticationGate;
          return { kind: 'local', id: 'local-installation' };
        },
      },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });

    const active = gateway.handle(envelope, 'local');
    gateway.closeAdmission();
    await expect(gateway.handle({ ...envelope, requestId: 'req_closed' }, 'local'))
      .resolves.toMatchObject({
        kind: 'unavailable',
        code: 'gateway_closing',
      });
    let drained = false;
    const draining = gateway.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseAuthentication!();
    await expect(active).resolves.toMatchObject({ status: 'accepted' });
    await draining;
  });
});

function workspaceInitializationEnvelope(): GatewayCommandEnvelope {
  return {
    ...envelope,
    requestId: 'req_workspace',
    idempotencyKey: 'idem_workspace',
    scope: { kind: 'workspace' },
    command: { kind: 'select_workspace', path: '/repo-a' },
  };
}

function deferredCompletion() {
  let resolve!: (value: {
    status: 'completed' | 'failed';
    reason?: string;
  }) => void;
  const promise = new Promise<{
    status: 'completed' | 'failed';
    reason?: string;
  }>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
