import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BindingConversationResolver } from '../../src/gateway/conversation-resolver.js';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';

let roots: string[] = [];

async function makeResolver(): Promise<{
  resolver: BindingConversationResolver;
  bindings: ConversationBindingRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'conv-resolver-'));
  roots.push(root);
  const bindings = new ConversationBindingRepository(join(root, 'bindings.json'));
  await bindings.initialize();
  const resolver = new BindingConversationResolver({
    bindings,
    createId: () => 'conv_new',
    verifyOwnership: async (accountId, conversationId) => (
      accountId === 'local-default' && conversationId === 'conv_1'
    ),
    createInWorkspace: async (_accountId, workspaceId) => (
      workspaceId === 'workspace_repo' ? 'conv_new' : Promise.reject(new Error('bad workspace'))
    ),
  });
  return { resolver, bindings };
}

afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe('BindingConversationResolver', () => {
  it('resolves an attach within the owning account', async () => {
    const { resolver } = await makeResolver();
    const result = await resolver.resolve('local-default', { mode: 'attach', conversationId: 'conv_1' });
    expect(result).toEqual({ status: 'resolved', conversationId: 'conv_1' });
  });

  it('denies a cross-account attach', async () => {
    const { resolver } = await makeResolver();
    const result = await resolver.resolve('acct-other', { mode: 'attach', conversationId: 'conv_1' });
    expect(result.status).toBe('denied');
  });

  it('resolves a bound conversation via an existing binding', async () => {
    const { resolver, bindings } = await makeResolver();
    await bindings.bind({ accountId: 'local-default', platform: 'feishu', channelId: 'chat_1', conversationId: 'conv_x' });

    const result = await resolver.resolve('local-default', {
      mode: 'bound',
      binding: { platform: 'feishu', channelId: 'chat_1' },
    });
    expect(result).toEqual({ status: 'resolved', conversationId: 'conv_x' });
  });

  it('creates and binds a new bound conversation', async () => {
    const { resolver, bindings } = await makeResolver();
    const result = await resolver.resolve('local-default', {
      mode: 'bound',
      binding: { platform: 'feishu', channelId: 'chat_new' },
    });
    expect(result).toEqual({ status: 'created', conversationId: 'conv_new' });
    expect(await bindings.resolve('local-default', 'feishu', 'chat_new')).toBe('conv_new');
  });

  it('creates a fresh conversation for new mode', async () => {
    const { resolver } = await makeResolver();
    const result = await resolver.resolve('local-default', {
      mode: 'new',
      workspaceId: 'workspace_repo',
    });
    expect(result).toEqual({ status: 'created', conversationId: 'conv_new' });
  });

  it('keeps dm, group and thread bindings separate', async () => {
    const { resolver, bindings } = await makeResolver();
    await bindings.bind({ accountId: 'local-default', platform: 'feishu', channelId: 'chat_1', conversationId: 'conv_dm' });
    await bindings.bind({ accountId: 'local-default', platform: 'feishu', channelId: 'chat_1', threadId: 'thread_1', conversationId: 'conv_thread' });

    const dm = await resolver.resolve('local-default', { mode: 'bound', binding: { platform: 'feishu', channelId: 'chat_1' } });
    const thread = await resolver.resolve('local-default', { mode: 'bound', binding: { platform: 'feishu', channelId: 'chat_1', threadId: 'thread_1' } });

    expect(dm).toEqual({ status: 'resolved', conversationId: 'conv_dm' });
    expect(thread).toEqual({ status: 'resolved', conversationId: 'conv_thread' });
  });
});
