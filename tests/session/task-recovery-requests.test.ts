import { describe, expect, it, vi } from 'vitest';
import { ConversationSession } from '../../src/session/conversation-session.js';
import type { ControlSnapshot } from '../../src/control/control-contracts.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ControlExecutionRuntime } from '../../src/execution/control-execution-runtime.js';

function sessionFor(input: { owner?: string; status?: string; verdict?: string; effect?: boolean }) {
  const item = { id: 'item', decisionId: 'item', status: input.status ?? 'pending',
    decision: { configurationRevision: 'rev', action: { type: 'complete_task', taskId: input.owner ?? 'task' } } };
  const session = Object.create(ConversationSession.prototype);
  session.deps = { runtimePort: { queries: {
    findTask: () => ({ id: 'task', status: 'needs_action' }),
    findRecoveryApplication: () => input.effect ? null : item,
    findRecoveryEffect: () => input.effect ? { id: 'item', taskId: input.owner ?? 'task', status: 'failed' } : null,
    diagnoseRecoveryApplication: () => ({ verdict: input.verdict ?? 'retry_safe' }),
  } } };
  return session as { buildRecoverySnapshot(taskId: string, id: string): Extract<ControlSnapshot, { type: 'recovery' }> };
}

describe('manual recovery request ownership and safety', () => {
  it.each([
    { owner: 'other', status: 'pending', accepted: false },
    { owner: 'task', status: 'assumed_applied', accepted: false },
    { owner: 'task', status: 'pending', accepted: true },
  ])('checks recovery ownership again at application: $owner / $status', async ({ owner, status, accepted }) => {
    const resolveRecoveryItem = vi.fn();
    const runtime = Object.create(ControlExecutionRuntime.prototype);
    runtime.deps = { recoveryItems: {
      findRecoveryItem: () => ({ status, decision: { action: { type: 'complete_task', taskId: owner } } }),
      resolveRecoveryItem,
    } };
    runtime.appendExecutionTrace = vi.fn();
    await runtime.applyExecutionDecision({ decision: {
      id: 'decision', action: { type: 'resolve_recovery', taskId: 'task', recoveryItemId: 'item', resolution: 'retry' },
    }, request: {} });
    expect(resolveRecoveryItem).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });
  it('creates a fresh retry command Turn that can show its successor Task', async () => {
    const trace = new InteractionTraceStream('conversation');
    trace.beginTurn({ turnId: 'old', userInput: 'old task' });
    const session = new ConversationSession({ conversationId: 'conversation', plannerSessionId: 'planner',
      runtimePort: { accountId: 'local-default', queries: { listTasks: () => [] } } as never,
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }), interactionTraceStream: trace,
      handleCommand: async () => {
        session.appendExecutionTrace({ phase: 'execution', actor: 'runtime', kind: 'remaining_work_linked',
          title: '续做任务', summary: '已失败', details: {}, taskId: 'successor' });
        return false;
      },
    });
    await session.submitUserInput('/task retry source', { interactionTurnId: 'retry-turn' });
    expect(trace.getSnapshot()).toMatchObject({ turnId: 'retry-turn', taskId: 'successor', status: 'completed' });
  });
  it.each([false, true])('rejects recovery items belonging to another Task (effect=%s)', effect => {
    expect(sessionFor({ owner: 'other', effect }).buildRecoverySnapshot('task', 'item').item).toBeNull();
  });

  it('rejects an already settled application instead of authorizing another retry', () => {
    expect(sessionFor({ status: 'assumed_applied' }).buildRecoverySnapshot('task', 'item').item).toBeNull();
  });

  it.each(['retry_safe', 'unresolved', 'applied', 'not_managed'])('uses the actual %s postcondition diagnosis', verdict => {
    expect(sessionFor({ verdict }).buildRecoverySnapshot('task', 'item').item?.retrySafe).toBe(verdict === 'retry_safe');
  });

  it('uses the owning graph pin for an effect that has no application row', async () => {
    const submitControl = vi.fn(async () => undefined);
    const session = Object.create(ConversationSession.prototype);
    session.deps = { plannerSessionId: 'conversation', runtimePort: {
      queries: {
        findRecoveryApplication: () => null,
        findRecoveryEffect: () => ({ id: 'effect', taskId: 'task', status: 'failed' }),
        findActiveWorkGraphRevision: () => ({ configurationRevision: 'revision-pinned' }),
      }, commands: { submitControl },
    } };
    session.appendOutput = vi.fn();
    session.formatTaskRecovery = () => '待核实';
    await session.resolveTaskRecovery({ taskId: 'task', recoveryItemId: 'effect', resolution: 'assume_applied' });
    expect(submitControl).toHaveBeenCalledWith(expect.objectContaining({ configurationRevision: 'revision-pinned' }), expect.anything());
  });
});
