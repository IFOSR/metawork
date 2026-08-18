import { describe, expect, it } from 'vitest';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';

function mockCoordinator(): AccountKernelCoordinator {
  return {
    submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
    recover: async () => ({
      decisions: [],
      quiescent: true,
      pendingRecovery: 0,
      reconciledProcessingEvents: 0,
      applicationCounts: { pending: 0, applying: 0, applied: 0, uncertain: 0, failed: 0 },
    }),
  };
}

function makePort(accountId: string): ConversationRuntimePort {
  return { accountId, kernelCoordinator: mockCoordinator() };
}

function makeSession(conversationId: string, plannerSessionId: string, accountId = 'local-default') {
  return new ConversationSession({
    conversationId,
    plannerSessionId,
    runtimePort: makePort(accountId),
    mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
  });
}

describe('ConversationSession', () => {
  it('keeps a stable planner session id for a stable conversation id', () => {
    const session = makeSession('conv_1', 'planner_1');
    expect(session.conversationId).toBe('conv_1');
    expect(session.plannerSessionId).toBe('planner_1');
  });

  it('owns output but no kernel or execution construction', () => {
    const session = makeSession('conv_1', 'planner_1');
    session.appendOutput('hello');
    expect(session.getOutput()).toEqual(['hello']);
    // Session 通过端口访问账户，不持有/构造 Kernel 服务。
    expect(session.accountId).toBe('local-default');
  });

  it('shares account facts but not output across conversations', () => {
    const sessionA = makeSession('conv_a', 'planner_a');
    const sessionB = makeSession('conv_b', 'planner_b');

    expect(sessionA.accountId).toBe(sessionB.accountId);
    sessionA.appendOutput('A only');
    expect(sessionB.getOutput()).toEqual([]);
  });

  it('tracks attached clients without destroying state on detach', () => {
    const session = makeSession('conv_1', 'planner_1');
    session.attachClient();
    session.attachClient();
    expect(session.attachedClientCount).toBe(2);

    session.detachClient();
    session.detachClient();
    expect(session.attachedClientCount).toBe(0);
    expect(session.conversationId).toBe('conv_1');
  });

  it('routes submission through its mailbox', () => {
    const session = makeSession('conv_1', 'planner_1');
    const receipt = session.submit({ requestId: 'req_1', idempotencyKey: 'idem_1' });
    expect(receipt.status).toBe('accepted');
  });
});
