import { describe, expect, it } from 'vitest';
import { FeishuPendingAttachmentStore } from '../../src/integrations/feishu-pending-attachments.js';

function setup(options: { ttlMs?: number } = {}) {
  let clock = 1_000_000;
  return {
    store: new FeishuPendingAttachmentStore({ ...options, nowMs: () => clock }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('FeishuPendingAttachmentStore (2026-09-06 plan §5.5)', () => {
  it('claims pending attachments only for the exact message route (chat + thread)', () => {
    const { store } = setup();
    store.add({ messageId: 'om_1', chatId: 'chat', path: '/tmp/a.png', name: 'a.png', resourceType: 'image' });
    store.add({
      messageId: 'om_2',
      chatId: 'chat',
      threadId: 'om_thread',
      path: '/tmp/b.png',
      name: 'b.png',
      resourceType: 'image',
    });

    const claimedMain = store.claimForText({ chatId: 'chat' });
    expect(claimedMain.map(item => item.name)).toEqual(['a.png']);
    const claimedThread = store.claimForText({ chatId: 'chat', threadId: 'om_thread' });
    expect(claimedThread.map(item => item.name)).toEqual(['b.png']);
    expect(store.claimForText({ chatId: 'chat' })).toEqual([]);
  });

  it('expires unclaimed attachments deterministically under a bounded TTL', () => {
    const { store, advance } = setup({ ttlMs: 1_000 });
    store.add({ messageId: 'om_1', chatId: 'chat', path: '/tmp/a.png', name: 'a.png', resourceType: 'image' });
    advance(999);
    expect(store.claimForText({ chatId: 'chat' })).toHaveLength(1);

    store.add({ messageId: 'om_2', chatId: 'chat', path: '/tmp/b.png', name: 'b.png', resourceType: 'image' });
    advance(1_001);
    expect(store.claimForText({ chatId: 'chat' })).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('bounds pending attachments per route by dropping the oldest', () => {
    const { store } = setup();
    for (let index = 0; index < 10; index += 1) {
      store.add({
        messageId: `om_${index}`,
        chatId: 'chat',
        path: `/tmp/${index}.png`,
        name: `${index}.png`,
        resourceType: 'image',
      });
    }
    const claimed = store.claimForText({ chatId: 'chat' });
    // maxPerRoute default 8: the two oldest were dropped deterministically.
    expect(claimed).toHaveLength(8);
    expect(claimed[0]!.name).toBe('2.png');
  });
});

describe('FeishuPendingAttachmentStore sender scoping and durability (closure)', () => {
  it('never hands one sender pending image to a different sender in a group chat', () => {
    const { store } = setup();
    store.add({
      messageId: 'om_a', chatId: 'group', senderId: 'user_a',
      path: '/tmp/a.png', name: 'a.png', resourceType: 'image',
    });
    expect(store.claimForText({ chatId: 'group', senderId: 'user_b' })).toEqual([]);
    expect(store.claimForText({ chatId: 'group', senderId: 'user_a' })).toHaveLength(1);
  });

  it('restores pending attachments from the durable ledger after a restart', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'feishu-pending-ledger-'));
    const ledgerPath = join(dir, 'pending.jsonl');
    try {
      const first = new FeishuPendingAttachmentStore({ ledgerPath });
      first.add({
        messageId: 'om_1', chatId: 'chat', senderId: 'user_a',
        path: '/tmp/keep.png', name: 'keep.png', resourceType: 'image',
      });
      const second = new FeishuPendingAttachmentStore({ ledgerPath });
      expect(second.claimForText({ chatId: 'chat', senderId: 'user_a' })).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('FeishuPendingAttachmentStore claim/tombstone semantics (closure round 3)', () => {
  it('keeps the downloaded file after claim so routing can read it', async () => {
    const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'feishu-pending-keep-'));
    const file = join(dir, 'keep.png');
    await writeFile(file, 'bytes');
    const { store } = setup();
    store.add({ messageId: 'om_keep', chatId: 'chat', senderId: 'user_a', path: file, name: 'keep.png', resourceType: 'image' });
    const claimed = store.claimForText({ chatId: 'chat', senderId: 'user_a' });
    expect(claimed).toHaveLength(1);
    await expect(readFile(file, 'utf8')).resolves.toBe('bytes'); // file survives claim
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a tombstone on claim so a restart never re-binds the attachment', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'feishu-pending-tombstone-'));
    const ledgerPath = join(dir, 'pending.jsonl');
    try {
      const first = new FeishuPendingAttachmentStore({ ledgerPath });
      first.add({
        messageId: 'om_tomb', chatId: 'chat', senderId: 'user_a',
        path: '/tmp/tomb.png', name: 'tomb.png', resourceType: 'image',
      });
      first.claimForText({ chatId: 'chat', senderId: 'user_a' });
      const second = new FeishuPendingAttachmentStore({ ledgerPath });
      expect(second.claimForText({ chatId: 'chat', senderId: 'user_a' })).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
