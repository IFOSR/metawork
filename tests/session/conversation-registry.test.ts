import { describe, expect, it } from 'vitest';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';

function makeSession(
  conversationId: string,
  options: { gate?: Promise<void>; disposed?: () => void } = {},
): ConversationSession {
  const coordinator: AccountKernelCoordinator = {
    submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
    recover: async () => ({
      decisions: [],
      quiescent: true,
      pendingRecovery: 0,
      reconciledProcessingEvents: 0,
      applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
    }),
  };
  const port: ConversationRuntimePort = { accountId: 'local-default', kernelCoordinator: coordinator } as unknown as ConversationRuntimePort;
  return new ConversationSession({
    conversationId,
    plannerSessionId: `planner_${conversationId}`,
    runtimePort: port,
    mailbox: new ConversationInputMailbox({
      execute: async () => {
        if (options.gate) await options.gate;
      },
    }),
    dispose: options.disposed ? async () => options.disposed!() : undefined,
  });
}

describe('ConversationRegistry', () => {
  it('opens a conversation once under concurrent requests', async () => {
    let opens = 0;
    const registry = new ConversationRegistry();
    const open = async () => {
      opens += 1;
      return makeSession('conv_1');
    };

    const [a, b] = await Promise.all([
      registry.getOrOpen('conv_1', open),
      registry.getOrOpen('conv_1', open),
    ]);

    expect(a).toBe(b);
    expect(opens).toBe(1);
  });

  it('returns an open session from getIfOpen', async () => {
    const registry = new ConversationRegistry();
    expect(registry.getIfOpen('conv_1')).toBeNull();

    await registry.getOrOpen('conv_1', async () => makeSession('conv_1'));
    expect(registry.getIfOpen('conv_1')?.conversationId).toBe('conv_1');
  });

  it('refuses to close a busy conversation', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = new ConversationRegistry();
    const session = await registry.getOrOpen('conv_1', async () => makeSession('conv_1', { gate }));
    session.submitCommand({ requestId: 'req_1', idempotencyKey: 'idem_1' });

    // 等 turn 活跃（busy）。
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await registry.closeIdle('conv_1')).toBe('busy');

    release!();
  });

  it('closes an idle conversation exactly once', async () => {
    let disposed = 0;
    const registry = new ConversationRegistry();
    await registry.getOrOpen('conv_1', async () => makeSession('conv_1', { disposed: () => { disposed += 1; } }));

    expect(await registry.closeIdle('conv_1')).toBe('closed');
    expect(disposed).toBe(1);
    expect(await registry.closeIdle('conv_1')).toBe('missing');
    expect(disposed).toBe(1);
  });

  it('waits for active conversation work during closeAll and rejects later opens', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let disposed = 0;
    const registry = new ConversationRegistry();
    const session = await registry.getOrOpen(
      'conv_1',
      async () => makeSession('conv_1', { gate, disposed: () => { disposed += 1; } }),
    );
    session.submitCommand({ requestId: 'req_1', idempotencyKey: 'idem_1' });
    await new Promise(resolve => setTimeout(resolve, 10));

    let closed = false;
    const closing = registry.closeAll().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(registry.getOrOpen('conv_2', async () => makeSession('conv_2')))
      .rejects.toThrow('Conversation registry is closing');

    release!();
    await closing;
    expect(disposed).toBe(1);
  });

  it('reviews every open conversation on the shared timer tick', async () => {
    const registry = new ConversationRegistry();
    const reviewed: string[] = [];
    for (const id of ['conv_1', 'conv_2']) {
      const session = makeSession(id);
      session.maybeReviewTaskPoolOnTimer = async () => {
        reviewed.push(id);
        return true;
      };
      await registry.getOrOpen(id, async () => session);
    }

    await expect(registry.reviewTaskPoolOnTimer(1_000)).resolves.toBe(true);
    expect(reviewed).toEqual(['conv_1', 'conv_2']);
  });

  it('waits for an in-flight timer review before disposing conversations', async () => {
    const registry = new ConversationRegistry();
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const session = makeSession('conv_1', {
      disposed: () => { calls.push('dispose'); },
    });
    session.maybeReviewTaskPoolOnTimer = async () => {
      calls.push('review:start');
      await gate;
      calls.push('review:end');
      return true;
    };
    await registry.getOrOpen('conv_1', async () => session);

    const review = registry.reviewTaskPoolOnTimer();
    await new Promise(resolve => setTimeout(resolve, 1));
    const closing = registry.closeAll();
    await Promise.resolve();
    expect(calls).toEqual(['review:start']);

    release!();
    await Promise.all([review, closing]);
    expect(calls).toEqual(['review:start', 'review:end', 'dispose']);
    await expect(registry.reviewTaskPoolOnTimer()).resolves.toBe(false);
  });
});
