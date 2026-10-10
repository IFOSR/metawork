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
  it.each(['/task resume task_1', '/task unblock task_1', '/task recover task_1 item_1 retry', 'natural language mislabeled as a slash command'])(
    'checks official rights before productive control %s but keeps cancellation available', async text => {
      let checked = 0; let submitted = 0;
      const gateway = new ClientGateway({
        authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
        accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
        conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
        activateAccount: async () => undefined,
        submitToConversation: async () => { submitted++; return { status: 'accepted' }; },
        newWorkAdmission: { check: async () => { checked++; return { allowed: false, reason: 'official_authorization_required' }; } },
      });
      const result = await gateway.handle({ ...envelope, command: { kind: 'slash_command', text } }, 'local');
      expect(result).toMatchObject({ status: 'rejected', code: 'official_authorization_required' });
      expect(checked).toBe(1); expect(submitted).toBe(0);
      const cancel = await gateway.handle({ ...envelope, requestId: 'cancel_1', idempotencyKey: 'cancel_1', command: { kind: 'slash_command', text: '/task cancel task_1' } }, 'local');
      expect(cancel).toMatchObject({ status: 'accepted' }); expect(checked).toBe(1); expect(submitted).toBe(1);
    });

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

  it('routes read-only queries to the transient branch without durable admission', async () => {
    const store = new MemoryCommandAdmissionStore();
    const queries: string[] = [];
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => { throw new Error('read-only queries must not activate accounts'); },
      submitToConversation: async () => { throw new Error('read-only queries must not reach the mailbox'); },
      commandAdmissionStore: store,
      handleReadOnlyQuery: async command => {
        queries.push(command.kind);
        return { status: 'accepted' };
      },
    });

    const completionEnvelope: GatewayCommandEnvelope = {
      ...envelope,
      requestId: 'req_completion',
      idempotencyKey: 'idem_completion',
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: 'conv_1' },
      },
      command: { kind: 'complete_command', text: '/task', cursor: 5 },
    };
    const receipt = await gateway.handle(completionEnvelope, 'local');
    expect(receipt).toMatchObject({ requestId: 'req_completion', status: 'accepted' });
    expect(queries).toEqual(['complete_command']);
    // 补全草稿不写入持久 admission 存储。
    await expect(store.listRecoverable()).resolves.toEqual([]);

    // 相同 idempotencyKey 重放得到 duplicate，不重复执行查询。
    const replay = await gateway.handle(completionEnvelope, 'local');
    expect(replay).toMatchObject({ status: 'duplicate' });
    expect(queries).toEqual(['complete_command']);

    // 相同 idempotencyKey 不同内容冲突。
    const conflict = await gateway.handle({
      ...completionEnvelope,
      requestId: 'req_completion_2',
      command: { kind: 'complete_command', text: '/memory' },
    }, 'local');
    expect(conflict).toMatchObject({ kind: 'conflict', code: 'idempotency_conflict' });
    expect(queries).toEqual(['complete_command']);
  });

  it('routes billing projections through the read-only branch without activating or submitting work', async () => {
    const queries: string[] = [];
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => {
        throw new Error('billing projections must not activate accounts');
      },
      submitToConversation: async () => {
        throw new Error('billing projections must not reach the mailbox');
      },
      handleReadOnlyQuery: async command => {
        queries.push(command.kind);
        return { status: 'accepted' };
      },
    });

    const result = await gateway.handle({
      ...envelope,
      requestId: 'req_bill',
      idempotencyKey: 'idem_bill',
      scope: { kind: 'workspace' },
      command: { kind: 'get_usage_summary', accountId: 'local-default' },
    }, 'local');

    expect(result).toMatchObject({ requestId: 'req_bill', status: 'accepted' });
    expect(queries).toEqual(['get_usage_summary']);
  });

  it('routes the Turn bill query through the read-only branch, not workspace admission', async () => {
    const queries: string[] = [];
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => {
        throw new Error('Turn bill queries must not activate accounts');
      },
      submitToConversation: async () => {
        throw new Error('Turn bill queries must not reach the mailbox');
      },
      handleWorkspaceCommand: async () => {
        throw new Error('Turn bill queries must not reach workspace admission');
      },
      handleReadOnlyQuery: async command => {
        queries.push(command.kind);
        return { status: 'accepted' };
      },
    });

    // 回归：isReadOnlyQuery 白名单漏掉 get_query_bill_for_turn 时，
    // 查询会掉进 workspace admission 分支并被 workspace_command_unavailable 拒绝，
    // TUI 永远拿不到账单投影。
    const result = await gateway.handle({
      ...envelope,
      requestId: 'req_turn_bill',
      idempotencyKey: 'idem_turn_bill',
      scope: { kind: 'workspace' },
      command: { kind: 'get_query_bill_for_turn', turnId: 'turn_1' },
    }, 'local');

    expect(result).toMatchObject({ requestId: 'req_turn_bill', status: 'accepted' });
    expect(queries).toEqual(['get_query_bill_for_turn']);
  });

  it('rejects read-only queries when the branch is unavailable and rate limits per connection', async () => {
    const unavailability = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });
    const taskViewEnvelope: GatewayCommandEnvelope = {
      ...envelope,
      requestId: 'req_task_view',
      idempotencyKey: 'idem_task_view',
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: 'conv_1' },
      },
      command: {
        kind: 'get_task_view',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        taskId: 'task_1',
      },
    };
    const unavailable = await unavailability.handle(taskViewEnvelope, 'local');
    expect(unavailable).toMatchObject({ status: 'rejected', reason: 'readonly_query_unavailable' });

    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
      handleReadOnlyQuery: async () => ({ status: 'accepted' }),
    });
    let rateLimited: unknown = null;
    for (let index = 0; index < 12; index += 1) {
      const result = await gateway.handle({
        ...taskViewEnvelope,
        requestId: `req_rl_${index}`,
        idempotencyKey: `idem_rl_${index}`,
      }, 'local');
      if ('status' in result && result.status === 'rejected' && result.reason === 'rate_limited') {
        rateLimited = result;
      }
    }
    expect(rateLimited).toMatchObject({ status: 'rejected', reason: 'rate_limited' });
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

  it('rejects new user work before durable admission when the required Agent is unavailable', async () => {
    const store = new MemoryCommandAdmissionStore();
    let activated = false;
    let resolved = false;
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: {
        resolve: async () => {
          resolved = true;
          return { status: 'created', conversationId: 'conv_1' };
        },
      },
      activateAccount: async () => {
        activated = true;
      },
      submitToConversation: async () => ({ status: 'accepted' }),
      commandAdmissionStore: store,
      newWorkAdmission: {
        check: () => ({
          allowed: false as const,
          reason: 'required_agent_unavailable' as const,
          agentId: 'pi-agent' as const,
        }),
      },
    });

    await expect(gateway.handle(envelope, 'local')).resolves.toMatchObject({
      status: 'rejected',
      reason: 'required_agent_unavailable',
      agentId: 'pi-agent',
    });
    expect(activated).toBe(false);
    expect(resolved).toBe(false);
    await expect(store.listRecoverable()).resolves.toEqual([]);
  });

  it('applies required-Agent admission to new conversations but not navigation or slash commands', async () => {
    const rejected = {
      allowed: false as const,
      reason: 'required_agent_unavailable' as const,
      agentId: 'pi-agent' as const,
    };
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
      handleWorkspaceCommand: async () => ({ status: 'accepted', conversationId: 'conv_new' }),
      newWorkAdmission: { check: () => rejected },
    });

    await expect(gateway.handle(createConversationEnvelope(), 'local')).resolves.toMatchObject({
      status: 'rejected',
      reason: 'required_agent_unavailable',
      agentId: 'pi-agent',
    });
    await expect(gateway.handle(selectWorkspaceEnvelope(), 'local'))
      .resolves.toMatchObject({ status: 'accepted' });
    await expect(gateway.handle(slashCommandEnvelope(), 'local'))
      .resolves.toMatchObject({ status: 'accepted' });
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
    await expect(gateway.handle(selectWorkspaceEnvelope(), 'local'))
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

    await expect(gateway.handle(selectWorkspaceEnvelope(), 'local'))
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

function selectWorkspaceEnvelope(): GatewayCommandEnvelope {
  return {
    ...envelope,
    requestId: 'req_workspace',
    idempotencyKey: 'idem_workspace',
    scope: { kind: 'workspace' },
    command: { kind: 'select_workspace', path: '/repo-a' },
  };
}

function createConversationEnvelope(): GatewayCommandEnvelope {
  return {
    ...envelope,
    requestId: 'req_create_conversation',
    idempotencyKey: 'idem_create_conversation',
    scope: { kind: 'workspace' },
    command: { kind: 'create_conversation', workspaceId: 'workspace_repo' },
  };
}

function slashCommandEnvelope(): GatewayCommandEnvelope {
  return {
    ...envelope,
    requestId: 'req_slash',
    idempotencyKey: 'idem_slash',
    command: { kind: 'slash_command', text: '/help' },
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
