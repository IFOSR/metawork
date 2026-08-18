import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationBindingRepository } from '../../src/session/conversation-binding-repository.js';
import {
  CONVERSATION_FORMAT_VERSION,
  type ConversationRecord,
} from '../../src/session/conversation-store.js';
import { FileConversationStore } from '../../src/session/file-conversation-store.js';

let tmpRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'conversation-store-'));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tmpRoots.map(root => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

function makeRecord(
  id: string,
  plannerSessionId: string,
  accountId = 'local-default',
): ConversationRecord {
  return {
    version: CONVERSATION_FORMAT_VERSION,
    conversation: {
      id,
      plannerSessionId,
      accountId,
      title: 'title',
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
      archived: false,
    },
    turns: [],
  };
}

describe('FileConversationStore', () => {
  it('writes, reads and archives a versioned account-scoped record', async () => {
    const root = await makeRoot();
    const store = new FileConversationStore(root);
    await store.initialize();

    const record = makeRecord('conv_1', 'planner_1');
    await store.writeConversation(record);
    await store.writeCatalog({
      version: CONVERSATION_FORMAT_VERSION,
      conversations: [record.conversation],
    });

    const loaded = await store.readConversation('conv_1');
    expect(loaded).toEqual(record);
    expect(loaded!.conversation.plannerSessionId).toBe('planner_1');
    expect(loaded!.conversation.accountId).toBe('local-default');

    const catalog = await store.readCatalog();
    expect(catalog.conversations).toEqual([record.conversation]);
  });

  it('keeps a stable planner session id across rewrites', async () => {
    const root = await makeRoot();
    const store = new FileConversationStore(root);
    await store.initialize();

    const record = makeRecord('conv_2', 'planner_stable');
    await store.writeConversation(record);

    const rewritten: ConversationRecord = {
      ...record,
      conversation: { ...record.conversation, updatedAt: '2026-08-18T00:00:01.000Z' },
      turns: [
        {
          id: 'turn_1',
          conversationId: 'conv_2',
          userInput: 'hello',
          finalAnswer: 'hi',
          status: 'completed',
        },
      ],
    };
    await store.writeConversation(rewritten);

    const loaded = await store.readConversation('conv_2');
    expect(loaded!.conversation.plannerSessionId).toBe('planner_stable');
    expect(loaded!.turns).toHaveLength(1);
  });

  it('quarantines an invalid record instead of returning it', async () => {
    const root = await makeRoot();
    const store = new FileConversationStore(root);
    await store.initialize();

    // 直接写一个损坏的 json 文件到 records 目录，绕过 store 校验。
    await writeFile(join(root, 'records', 'conv_bad.json'), '{ not valid json', 'utf8');

    const loaded = await store.readConversation('conv_bad');
    expect(loaded).toBeNull();

    const quarantined = await readdir(join(root, 'quarantine')).catch(() => [] as string[]);
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it('rejects an unsafe conversation id', async () => {
    const root = await makeRoot();
    const store = new FileConversationStore(root);
    await store.initialize();

    await expect(
      store.writeConversation(makeRecord('../evil', 'planner_1')),
    ).rejects.toThrow();
  });
});

describe('ConversationBindingRepository', () => {
  it('binds and resolves platform/channel/thread within one account', async () => {
    const root = await makeRoot();
    const repository = new ConversationBindingRepository(join(root, 'bindings.json'));
    await repository.initialize();

    await repository.bind({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      conversationId: 'conv_1',
    });
    await repository.bind({
      accountId: 'local-default',
      platform: 'feishu',
      channelId: 'chat_1',
      threadId: 'thread_1',
      conversationId: 'conv_2',
    });

    expect(await repository.resolve('local-default', 'feishu', 'chat_1')).toBe('conv_1');
    expect(await repository.resolve('local-default', 'feishu', 'chat_1', 'thread_1')).toBe('conv_2');
    expect(await repository.resolve('local-default', 'feishu', 'chat_1', 'thread_other')).toBeNull();
  });

  it('cannot resolve a binding across accounts', async () => {
    const root = await makeRoot();
    const repository = new ConversationBindingRepository(join(root, 'bindings.json'));
    await repository.initialize();

    await repository.bind({
      accountId: 'acct-one',
      platform: 'feishu',
      channelId: 'chat_1',
      conversationId: 'conv_1',
    });

    expect(await repository.resolve('acct-one', 'feishu', 'chat_1')).toBe('conv_1');
    expect(await repository.resolve('acct-two', 'feishu', 'chat_1')).toBeNull();
  });
});
