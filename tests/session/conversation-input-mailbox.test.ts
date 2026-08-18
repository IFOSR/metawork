import { describe, expect, it } from 'vitest';
import {
  ConversationInputMailbox,
  type MailboxCommand,
} from '../../src/session/conversation-input-mailbox.js';

function makeCommand(requestId: string, idempotencyKey: string): MailboxCommand {
  return { requestId, idempotencyKey };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('ConversationInputMailbox', () => {
  it('executes commands in FIFO order', async () => {
    const executed: string[] = [];
    const mailbox = new ConversationInputMailbox({
      execute: async command => { executed.push(command.requestId); },
    });

    mailbox.submit(makeCommand('req_1', 'idem_1'));
    mailbox.submit(makeCommand('req_2', 'idem_2'));

    await waitFor(() => executed.length === 2);
    expect(executed).toEqual(['req_1', 'req_2']);
  });

  it('returns the first receipt for a duplicate idempotency key', () => {
    const mailbox = new ConversationInputMailbox({ execute: async () => undefined });

    const first = mailbox.submit(makeCommand('req_1', 'idem_1'));
    const duplicate = mailbox.submit(makeCommand('req_2', 'idem_1'));

    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
  });

  it('keeps only one active turn at a time', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const mailbox = new ConversationInputMailbox({
      execute: async () => {
        activeCount += 1;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeCount -= 1;
      },
    });

    mailbox.submit(makeCommand('req_1', 'idem_1'));
    mailbox.submit(makeCommand('req_2', 'idem_2'));

    await waitFor(() => !mailbox.isActive && mailbox.queueLength === 0);
    expect(maxActive).toBe(1);
  });

  it('releases the next turn after a failure', async () => {
    const executed: string[] = [];
    const mailbox = new ConversationInputMailbox({
      execute: async command => {
        executed.push(command.requestId);
        if (command.requestId === 'req_1') throw new Error('boom');
      },
    });

    mailbox.submit(makeCommand('req_1', 'idem_1'));
    mailbox.submit(makeCommand('req_2', 'idem_2'));

    await waitFor(() => executed.length === 2);
    expect(executed).toEqual(['req_1', 'req_2']);
  });

  it('cancels a queued turn', async () => {
    const executed: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const mailbox = new ConversationInputMailbox({
      execute: async command => {
        if (command.requestId === 'req_1') {
          await firstGate;
        }
        executed.push(command.requestId);
      },
    });

    mailbox.submit(makeCommand('req_1', 'idem_1'));
    mailbox.submit(makeCommand('req_2', 'idem_2'));
    mailbox.submit(makeCommand('req_3', 'idem_3'));

    // 等 req_1 成为活跃，req_2/req_3 在队列。
    await waitFor(() => mailbox.isActive);
    expect(mailbox.cancel('req_2')).toBe(true);

    releaseFirst!();
    await waitFor(() => executed.length === 2);
    expect(executed).toEqual(['req_1', 'req_3']);
  });

  it('rejects when the queue is full', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const mailbox = new ConversationInputMailbox({
      execute: async () => { await firstGate; },
      maxQueueSize: 2,
    });

    mailbox.submit(makeCommand('req_1', 'idem_1'));
    const second = mailbox.submit(makeCommand('req_2', 'idem_2'));
    const third = mailbox.submit(makeCommand('req_3', 'idem_3'));

    // 活跃 1 + 队列 1 = 2，第三个应被拒绝。
    expect(second.status).toBe('accepted');
    expect(third.status).toBe('rejected');
    expect(third.reason).toBe('busy');

    releaseFirst!();
  });
});
