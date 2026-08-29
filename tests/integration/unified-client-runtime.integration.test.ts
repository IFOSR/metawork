import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRuntimeFactory } from '../../src/account/account-runtime-factory.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import { BindingConversationResolver } from '../../src/gateway/conversation-resolver.js';
import { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import { FeishuConversationRouting } from '../../src/gateway/feishu-conversation-routing.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';
import { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import type { GatewayEventEnvelope, GatewayEventKind } from '../../src/gateway/client-events.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function makeComposition() {
  const root = await mkdtemp(join(tmpdir(), 'unified-e2e-'));
  roots.push(root);

  let recoveryCount = 0;
  const factory = new AccountRuntimeFactory({
    buildKernelCoordinator: (): AccountKernelCoordinator => ({
      submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
      recover: async () => ({
        decisions: [],
        quiescent: true,
        pendingRecovery: 0,
        reconciledProcessingEvents: 0,
        applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
      }),
    }),
    recoverDurableStartup: async () => { recoveryCount += 1; },
  });
  const registry = new RuntimeRegistry({ factory });

  const bindings = new ConversationBindingRepository(join(root, 'bindings.json'));
  await bindings.initialize();
  let conversationCounter = 0;
  const conversationWorkspaces = new Map<string, string>();
  const createConversation = (workspaceId: string) => {
    conversationCounter += 1;
    const conversationId = `conv_${conversationCounter}`;
    conversationWorkspaces.set(conversationId, workspaceId);
    return conversationId;
  };
  const resolver = new BindingConversationResolver({
    bindings,
    createId: () => createConversation('workspace_repo'),
    createInWorkspace: async (_accountId, workspaceId) => createConversation(workspaceId),
  });

  const journal = new FileEventJournal(join(root, 'journal'));
  const subscriptions = new GatewaySubscriptions();
  const submitted: Array<{ conversationId: string; requestId: string; idempotencyKey: string }> = [];

  const gateway = new ClientGateway({
    authenticator: {
      authenticate: async input => {
        if (input.transport === 'local') return { kind: 'local', id: 'local-installation' };
        if (input.transport === 'web') return { kind: 'web', id: 'web_user' };
        if (input.transport === 'feishu') return { kind: 'feishu', id: 'tenant:user' };
        return null;
      },
    },
    accountResolver: {
      resolve: async () => ({ status: 'authorized', accountId: LOCAL_DEFAULT_ACCOUNT_ID }),
    },
    conversationResolver: resolver,
    activateAccount: async accountId => {
      await registry.getOrActivate({ accountId, authorized: true });
    },
    submitToConversation: async (conversationId, requestId, idempotencyKey) => {
      submitted.push({ conversationId, requestId, idempotencyKey });
      return { requestId, idempotencyKey, status: 'accepted' };
    },
    handleWorkspaceCommand: async command => {
      if (command.kind === 'select_workspace') {
        return { status: 'accepted', workspaceId: 'workspace_repo' };
      }
      if (command.kind === 'create_conversation') {
        return {
          status: 'accepted',
          workspaceId: command.workspaceId,
          conversationId: createConversation(command.workspaceId),
        };
      }
      return {
        status: 'accepted',
        workspaceId: 'workspaceId' in command
          ? command.workspaceId
          : 'workspace_repo',
      };
    },
  });

  const webAdapter = new WebGatewayAdapter({ gateway, journal, subscriptions });
  const selectedWorkspaces = new Map<string, string>();
  const feishuRouting = new FeishuConversationRouting({
    accountId: LOCAL_DEFAULT_ACCOUNT_ID,
    gateway,
    bindings,
    restoreWorkspace: async (connectionId, workspaceId) => {
      selectedWorkspaces.set(connectionId, workspaceId);
    },
    resolveConversationWorkspace: async (_accountId, conversationId) => (
      conversationWorkspaces.get(conversationId) ?? null
    ),
  });
  const feishuAdapter = new FeishuGatewayAdapter({
    gateway,
    routing: feishuRouting,
  });

  return {
    registry,
    journal,
    subscriptions,
    webAdapter,
    feishuAdapter,
    bindings,
    submitted,
    recoveryCount: () => recoveryCount,
    appendEvent: (id: string, kind: GatewayEventKind, conversationId = 'conv_1') => {
      const event: GatewayEventEnvelope = {
        protocolVersion: 2,
        eventId: id,
        sequence: 0,
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        conversationId,
        requestId: null,
        turnId: null,
        kind,
        payload: {},
        occurredAt: '2026-08-18T00:00:00.000Z',
      };
      return journal.append(event);
    },
  };
}

function webEnvelope(
  requestId: string,
  idempotencyKey: string,
  selection: Extract<GatewayCommandEnvelope['scope'], { kind: 'conversation' }>['selection'],
): GatewayCommandEnvelope {
  return {
    protocolVersion: 2,
    requestId,
    idempotencyKey,
    connectionId: 'web',
    scope: { kind: 'conversation', selection },
    command: { kind: 'user_message', text: 'hello', attachments: [] },
    clientCapabilities: [],
  };
}

describe('unified client runtime integration', () => {
  it('activates the account runtime once across surfaces', async () => {
    const c = await makeComposition();
    await c.webAdapter.submit(webEnvelope(
      'req_1',
      'idem_1',
      { mode: 'new', workspaceId: 'workspace_repo' },
    ));
    await c.webAdapter.submit(webEnvelope(
      'req_2',
      'idem_2',
      { mode: 'new', workspaceId: 'workspace_repo' },
    ));
    await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_1' },
      '/workspace /repo',
      'req_workspace',
      'idem_workspace',
    );
    await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_1' },
      'hello',
      'req_3',
      'idem_3',
    );

    // 账户激活一次（recovery 单飞行）。
    expect(c.recoveryCount()).toBe(1);
    expect(c.registry.getIfLoaded(LOCAL_DEFAULT_ACCOUNT_ID)).not.toBeNull();
  });

  it('isolates conversations across surfaces', async () => {
    const c = await makeComposition();
    await c.webAdapter.submit(webEnvelope(
      'req_1',
      'idem_1',
      { mode: 'new', workspaceId: 'workspace_repo' },
    ));
    await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_a' },
      '/workspace /repo',
      'req_workspace',
      'idem_workspace',
    );
    await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_a' },
      'hello',
      'req_2',
      'idem_2',
    );

    const conversations = new Set(c.submitted.map(item => item.conversationId));
    expect(conversations.size).toBe(2);
  });

  it('keeps a duplicate feishu event from creating a second turn', async () => {
    const c = await makeComposition();
    await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_1' },
      '/workspace /repo',
      'req_workspace',
      'idem_workspace',
    );
    await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_1' },
      'hello',
      'req_1',
      'webhook_event_1',
    );
    const duplicate = await c.feishuAdapter.handleMessage(
      { tenantKey: 'tenant', userId: 'user' },
      { chatId: 'chat_1' },
      'hello',
      'req_2',
      'webhook_event_1',
    );

    expect(duplicate).toMatchObject({ status: 'duplicate' });
    expect(c.submitted).toHaveLength(1);
  });

  it('replays events after a cursor for reconnect', async () => {
    const c = await makeComposition();
    await c.appendEvent('e1', 'turn_started');
    await c.appendEvent('e2', 'trace_delta');
    await c.appendEvent('e3', 'final_answer');

    const replay = await c.webAdapter.replay(LOCAL_DEFAULT_ACCOUNT_ID, 'conv_1', 1);
    expect(replay.deltas.map(event => event.eventId)).toEqual(['e2']);
    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e3']);
  });
});
