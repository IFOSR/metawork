import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientGateway, ClientGatewayResult } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import {
  FeishuConversationRouting,
  type FeishuConversationRoutingDeps,
} from '../../src/gateway/feishu-conversation-routing.js';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function makeRouting(
  overrides: Partial<FeishuConversationRoutingDeps> = {},
): Promise<{
  routing: FeishuConversationRouting;
  bindings: ConversationBindingRepository;
  envelopes: GatewayCommandEnvelope[];
  restoreWorkspace: ReturnType<typeof vi.fn>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-routing-'));
  roots.push(root);
  const bindings = new ConversationBindingRepository(join(root, 'bindings.json'));
  await bindings.initialize();
  const envelopes: GatewayCommandEnvelope[] = [];
  const gateway = {
    handle: vi.fn(async (envelope: GatewayCommandEnvelope): Promise<ClientGatewayResult> => {
      envelopes.push(envelope);
      if (envelope.command.kind === 'select_workspace') {
        return receipt(envelope, { workspaceId: 'workspace_repo' });
      }
      if (envelope.command.kind === 'create_conversation') {
        return receipt(envelope, {
          workspaceId: envelope.command.workspaceId,
          conversationId: 'conv_new',
        });
      }
      const conversationId = 'conversationId' in envelope.command
        ? envelope.command.conversationId
        : envelope.scope.kind === 'conversation'
          && envelope.scope.selection.mode === 'attach'
          ? envelope.scope.selection.conversationId
          : null;
      return receipt(envelope, {
        workspaceId: envelope.scope.kind === 'workspace'
          && 'workspaceId' in envelope.command
          ? envelope.command.workspaceId
          : undefined,
        conversationId,
      });
    }),
  } as unknown as ClientGateway;
  const restoreWorkspace = vi.fn().mockResolvedValue(undefined);
  const deps: FeishuConversationRoutingDeps = {
    accountId: 'local-default',
    gateway,
    bindings,
    restoreWorkspace,
    resolveConversationWorkspace: async (_accountId, conversationId) => (
      conversationId === 'conv_other' ? 'workspace_other' : 'workspace_repo'
    ),
    ...overrides,
  };
  return {
    routing: new FeishuConversationRouting(deps),
    bindings,
    envelopes,
    restoreWorkspace,
  };
}

const sender = { tenantKey: 'tenant_1', userId: 'user_1' };
const channel = { chatId: 'chat_1' };

describe('FeishuConversationRouting', () => {
  it('selects a Workspace and clears an attached Conversation from another Workspace', async () => {
    const { routing, bindings, envelopes } = await makeRouting();
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      workspaceId: 'workspace_old',
      conversationId: 'conv_old',
    });

    const result = await routing.routeMessage(
      sender,
      channel,
      '/workspace /repo',
      'req_workspace',
      'idem_workspace',
    );

    expect(result).toMatchObject({
      status: 'accepted',
      routeKind: 'workspace_directory',
      workspaceId: 'workspace_repo',
      conversationId: null,
    });
    expect(envelopes[0]).toMatchObject({
      connectionId: expect.stringMatching(/^feishu_/),
      scope: { kind: 'workspace' },
      command: { kind: 'select_workspace', path: '/repo' },
    });
    expect(await bindings.resolveBinding(
      'local-default',
      'feishu',
      'chat_1',
    )).toMatchObject({
      workspaceId: 'workspace_repo',
      conversationId: null,
    });
  });

  it('restores a persisted Workspace before listing its bounded directory', async () => {
    const { routing, bindings, envelopes, restoreWorkspace } = await makeRouting();
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      workspaceId: 'workspace_repo',
      conversationId: null,
    });

    const result = await routing.routeMessage(
      sender,
      channel,
      '/conversations',
      'req_list',
      'idem_list',
    );

    expect(restoreWorkspace).toHaveBeenCalledWith(
      expect.stringMatching(/^feishu_/),
      'workspace_repo',
      'feishu:tenant_1:user_1',
    );
    expect(envelopes[0]).toMatchObject({
      scope: { kind: 'workspace' },
      command: {
        kind: 'list_workspace_conversations',
        workspaceId: 'workspace_repo',
      },
    });
    expect(result).toMatchObject({
      status: 'accepted',
      routeKind: 'workspace_directory',
      workspaceId: 'workspace_repo',
    });
  });

  it('attaches only a Conversation in the selected Account Workspace', async () => {
    const { routing, bindings, envelopes } = await makeRouting();
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      workspaceId: 'workspace_repo',
      conversationId: null,
    });

    const attached = await routing.routeMessage(
      sender,
      channel,
      '/conversation conv_1',
      'req_attach',
      'idem_attach',
    );
    const denied = await routing.routeMessage(
      sender,
      channel,
      '/conversation conv_other',
      'req_cross',
      'idem_cross',
    );

    expect(attached).toMatchObject({
      status: 'accepted',
      routeKind: 'conversation_attached',
      workspaceId: 'workspace_repo',
      conversationId: 'conv_1',
    });
    expect(envelopes[0]).toMatchObject({
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: 'conv_1' },
      },
      command: { kind: 'attach_conversation', conversationId: 'conv_1' },
    });
    expect(envelopes[1]).toMatchObject({
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: 'conv_1' },
      },
      command: {
        kind: 'get_conversation_history',
        conversationId: 'conv_1',
        limit: 3,
      },
    });
    expect(denied).toMatchObject({
      status: 'rejected',
      reason: 'conversation_not_in_workspace',
    });
    expect(envelopes).toHaveLength(2);
  });

  it('requests bounded history only for the attached Conversation and forwards opaque cursors', async () => {
    const { routing, bindings, envelopes } = await makeRouting();
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      workspaceId: 'workspace_repo',
      conversationId: 'conv_1',
    });

    await routing.routeMessage(
      sender,
      channel,
      '/history 999',
      'req_history',
      'idem_history',
    );
    await routing.routeCardAction(sender, channel, {
      kind: 'conversation_history',
      cursor: 'cursor_next',
      limit: 12,
    }, 'req_cursor', 'idem_cursor');

    expect(envelopes.map(envelope => envelope.command)).toEqual([
      {
        kind: 'get_conversation_history',
        conversationId: 'conv_1',
        limit: 50,
      },
      {
        kind: 'get_conversation_history',
        conversationId: 'conv_1',
        cursor: 'cursor_next',
        limit: 12,
      },
    ]);
    expect(envelopes.every(envelope => (
      envelope.scope.kind === 'conversation'
      && envelope.scope.selection.mode === 'attach'
      && envelope.scope.selection.conversationId === 'conv_1'
    ))).toBe(true);
  });

  it('creates a Conversation on the first ordinary message in a selected Workspace', async () => {
    const { routing, bindings, envelopes } = await makeRouting();
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      workspaceId: 'workspace_repo',
      conversationId: null,
    });

    const result = await routing.routeMessage(
      sender,
      channel,
      'implement this',
      'req_message',
      'idem_message',
    );

    expect(envelopes.map(envelope => envelope.command)).toEqual([
      { kind: 'create_conversation', workspaceId: 'workspace_repo' },
      { kind: 'user_message', text: 'implement this', attachments: [] },
    ]);
    expect(result).toMatchObject({
      status: 'accepted',
      routeKind: 'conversation_terminal',
      conversationId: 'conv_new',
    });
    expect(await bindings.resolve('local-default', 'feishu', 'chat_1')).toBe('conv_new');
  });

  it('fails closed when no Workspace is selected', async () => {
    const { routing, envelopes } = await makeRouting();

    await expect(routing.routeMessage(
      sender,
      channel,
      'implement this',
      'req_message',
      'idem_message',
    )).resolves.toMatchObject({
      status: 'rejected',
      reason: 'workspace_required',
      conversationId: null,
    });
    expect(envelopes).toHaveLength(0);
  });

  it('keeps chat and thread Workspace/Conversation selections independent', async () => {
    const { routing, bindings } = await makeRouting();

    await routing.routeMessage(
      sender,
      { chatId: 'chat_1' },
      '/workspace /repo',
      'req_chat',
      'idem_chat',
    );
    await routing.routeMessage(
      sender,
      { chatId: 'chat_1', threadId: 'thread_1' },
      '/workspace /repo',
      'req_thread',
      'idem_thread',
    );
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      threadId: 'thread_1',
      workspaceId: 'workspace_repo',
      conversationId: 'conv_thread',
    });

    expect(await bindings.resolveBinding(
      'local-default',
      'feishu',
      'chat_1',
    )).toMatchObject({
      workspaceId: 'workspace_repo',
      conversationId: null,
    });
    expect(await bindings.resolveBinding(
      'local-default',
      'feishu',
      'chat_1',
      'thread_1',
    )).toMatchObject({
      workspaceId: 'workspace_repo',
      conversationId: 'conv_thread',
    });
  });

  it('serializes first messages so one chat creates only one Conversation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-routing-concurrency-'));
    roots.push(root);
    const bindings = new ConversationBindingRepository(join(root, 'bindings.json'));
    await bindings.initialize();
    await bindings.set({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      workspaceId: 'workspace_repo',
      conversationId: null,
    });
    const envelopes: GatewayCommandEnvelope[] = [];
    let createCount = 0;
    const gateway = {
      handle: vi.fn(async (envelope: GatewayCommandEnvelope) => {
        envelopes.push(envelope);
        if (envelope.command.kind === 'create_conversation') {
          createCount += 1;
          await new Promise(resolve => setTimeout(resolve, 10));
          return receipt(envelope, {
            workspaceId: 'workspace_repo',
            conversationId: `conv_${createCount}`,
          });
        }
        const conversationId = envelope.scope.kind === 'conversation'
          && envelope.scope.selection.mode === 'attach'
          ? envelope.scope.selection.conversationId
          : null;
        return receipt(envelope, { conversationId });
      }),
    } as unknown as ClientGateway;
    const routing = new FeishuConversationRouting({
      accountId: 'local-default',
      gateway,
      bindings,
      restoreWorkspace: async () => undefined,
      resolveConversationWorkspace: async () => 'workspace_repo',
    });

    await Promise.all([
      routing.routeMessage(sender, channel, 'first', 'req_1', 'idem_1'),
      routing.routeMessage(sender, channel, 'second', 'req_2', 'idem_2'),
    ]);

    expect(createCount).toBe(1);
    const userSelections = envelopes
      .filter(envelope => envelope.command.kind === 'user_message')
      .map(envelope => (
        envelope.scope.kind === 'conversation'
        && envelope.scope.selection.mode === 'attach'
          ? envelope.scope.selection.conversationId
          : null
      ));
    expect(userSelections).toEqual(['conv_1', 'conv_1']);
  });

  it('recovers a legacy Conversation binding Workspace after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-routing-restart-'));
    roots.push(root);
    const path = join(root, 'bindings.json');
    await writeFile(path, JSON.stringify([{
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      conversationId: 'conv_1',
    }]));
    const bindings = new ConversationBindingRepository(path);
    await bindings.initialize();
    const restoreWorkspace = vi.fn().mockResolvedValue(undefined);
    const gateway = {
      handle: vi.fn(async (envelope: GatewayCommandEnvelope) => receipt(envelope, {
        conversationId: 'conv_1',
      })),
    } as unknown as ClientGateway;
    const routing = new FeishuConversationRouting({
      accountId: 'local-default',
      gateway,
      bindings,
      restoreWorkspace,
      resolveConversationWorkspace: async () => 'workspace_repo',
    });

    await routing.routeMessage(
      sender,
      channel,
      '/history',
      'req_history',
      'idem_history',
    );

    expect(restoreWorkspace).toHaveBeenCalledWith(
      expect.stringMatching(/^feishu_/),
      'workspace_repo',
      'feishu:tenant_1:user_1',
    );
    expect(JSON.parse(await readFile(path, 'utf8'))[0]).toMatchObject({
      workspaceId: 'workspace_repo',
      conversationId: 'conv_1',
    });
  });
});

function receipt(
  envelope: GatewayCommandEnvelope,
  values: { workspaceId?: string; conversationId?: string | null },
): ClientGatewayResult {
  return {
    requestId: envelope.requestId,
    idempotencyKey: envelope.idempotencyKey,
    status: 'accepted',
    conversationId: values.conversationId ?? null,
    ...(values.workspaceId ? { workspaceId: values.workspaceId } : {}),
  };
}
