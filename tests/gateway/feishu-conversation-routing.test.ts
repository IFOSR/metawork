import { describe, expect, it } from 'vitest';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import { BindingConversationResolver } from '../../src/gateway/conversation-resolver.js';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';
import { FeishuGatewayAdapter } from '../../src/gateway/feishu-gateway-adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function makeAdapter(): Promise<{
  adapter: FeishuGatewayAdapter;
  bindings: ConversationBindingRepository;
  submitted: Array<{ conversationId: string; requestId: string }>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'feishu-gateway-'));
  roots.push(root);

  const bindings = new ConversationBindingRepository(join(root, 'bindings.json'));
  await bindings.initialize();

  const submitted: Array<{ conversationId: string; requestId: string }> = [];
  let conversationCounter = 0;
  const resolver = new BindingConversationResolver({
    bindings,
    createId: () => {
      conversationCounter += 1;
      return `conv_${conversationCounter}`;
    },
  });

  const gateway = new ClientGateway({
    authenticator: {
      authenticate: async input => (
        input.transport === 'feishu' ? { kind: 'feishu', id: 'tenant:user' } : null
      ),
    },
    accountResolver: {
      resolve: async principal => (
        principal.kind === 'feishu'
          ? { status: 'authorized', accountId: 'local-default' }
          : { status: 'denied', reason: 'not feishu' }
      ),
    },
    conversationResolver: resolver,
    activateAccount: async () => undefined,
    submitToConversation: async (conversationId, requestId, idempotencyKey) => {
      submitted.push({ conversationId, requestId });
      return { requestId, idempotencyKey, status: 'accepted' };
    },
  });

  return { adapter: new FeishuGatewayAdapter({ gateway }), bindings, submitted };
}

describe('FeishuGatewayAdapter', () => {
  it('derives a feishu principal from tenant and user identity', () => {
    const adapter = new FeishuGatewayAdapter({ gateway: null as never });
    const principal = adapter.feishuPrincipal({ tenantKey: 'tenant_1', userId: 'user_1' });
    expect(principal).toEqual({ kind: 'feishu', id: 'tenant_1:user_1' });
  });

  it('routes a message through the gateway into a bound conversation', async () => {
    const { adapter, submitted } = await makeAdapter();
    const result = await adapter.handleMessage(
      { tenantKey: 'tenant_1', userId: 'user_1' },
      { chatId: 'chat_1' },
      'hello',
      'req_1',
      'idem_1',
    );
    expect(result).toMatchObject({ status: 'accepted' });
    expect(submitted).toHaveLength(1);
  });

  it('keeps dm, group and thread conversations separate', async () => {
    const { adapter, bindings } = await makeAdapter();

    await adapter.handleMessage(
      { tenantKey: 'tenant_1', userId: 'user_1' },
      { chatId: 'chat_dm' },
      'dm',
      'req_1',
      'idem_1',
    );
    await adapter.handleMessage(
      { tenantKey: 'tenant_1', userId: 'user_1' },
      { chatId: 'chat_group', threadId: 'thread_1' },
      'thread',
      'req_2',
      'idem_2',
    );

    const dm = await bindings.resolve('local-default', 'feishu', 'chat_dm');
    const thread = await bindings.resolve('local-default', 'feishu', 'chat_group', 'thread_1');
    expect(dm).toBeTruthy();
    expect(thread).toBeTruthy();
    expect(dm).not.toBe(thread);
  });

  it('creates one turn for a repeated webhook event id', async () => {
    const { adapter, submitted } = await makeAdapter();

    await adapter.handleMessage(
      { tenantKey: 'tenant_1', userId: 'user_1' },
      { chatId: 'chat_1' },
      'hello',
      'req_1',
      'webhook_event_1',
    );
    const duplicate = await adapter.handleMessage(
      { tenantKey: 'tenant_1', userId: 'user_1' },
      { chatId: 'chat_1' },
      'hello',
      'req_2',
      'webhook_event_1',
    );

    expect(duplicate).toMatchObject({ status: 'duplicate' });
    expect(submitted).toHaveLength(1);
  });
});
