import { describe, expect, it, vi } from 'vitest';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function port(overrides: Partial<ConversationRuntimePort> = {}): ConversationRuntimePort {
  const base = {
    accountId: 'local-default',
    planning: null,
    permissions: null,
    queries: {
      findTask: () => null,
      listTasks: () => [],
      listTasksByStatus: () => [],
      listSubtasks: () => [],
      findSubtask: () => null,
      listKernelDecisionsByTask: () => [],
      findKernelEvent: () => null,
      listAttemptReceipts: () => [],
      getConversationTaskSlot: () => ({ conversationId: 'conv_cancel', activeTaskId: null, state: 'free' }),
      findOldestPendingPermission: () => null,
    },
    commands: {
      submitKernel: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
      materializeCompletedEvidence: () => undefined,
      resolveRecoveryApplication: () => undefined,
      resolveRecoveryEffect: () => undefined,
      refreshExecutors: async () => ({ configurationRevision: 'r', trigger: 'manual', checked: [], recovered: [], stillError: [], skipped: [] }),
    },
    execution: null,
  } as unknown as ConversationRuntimePort;
  return {
    ...base,
    ...overrides,
    queries: { ...base.queries, ...overrides.queries },
    commands: { ...base.commands, ...overrides.commands },
  } as ConversationRuntimePort;
}

const configuration = {
  revisionId: 'revision-test',
  contentHash: 'hash',
  models: [],
  routingCatalog: { configurationRevision: 'revision-test', agentClasses: [] },
};

function sessionWith(options: {
  planning: ConversationRuntimePort['planning'];
  cancelPlannerTurn?: (sessionId: string) => Promise<void>;
  kernelExecutionRuntime?: { cancelTask: (taskId: string, reason?: string) => Promise<unknown> } | null;
}): {
  session: ConversationSession;
  trace: InteractionTraceStream;
  cancelPlannerTurn: ReturnType<typeof vi.fn>;
  submitKernel: ReturnType<typeof vi.fn>;
  cancelTask: ReturnType<typeof vi.fn>;
} {
  const trace = new InteractionTraceStream('conv_cancel');
  const cancelPlannerTurn = vi.fn(options.cancelPlannerTurn ?? (async () => undefined));
  const submitKernel = vi.fn(async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }));
  const cancelTask = vi.fn(async () => ({ taskId: 'task_x' }));
  const session = new ConversationSession({
    conversationId: 'conv_cancel',
    plannerSessionId: 'planner_cancel',
    runtimePort: port({
      planning: options.planning,
      commands: { cancelPlannerTurn, submitKernel: submitKernel as never },
      queries: {
        getConversationTaskSlot: () => ({ conversationId: 'conv_cancel', activeTaskId: 'task_x', state: 'occupied' }),
      },
    } as never),
    mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
    interactionTraceStream: trace,
    planningContextBuilder: {
      build: (input: { userInput: string; attachments?: unknown[] }) => ({
        userInput: input.userInput,
        ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        request: { sessionId: 'planner_cancel', source: 'gateway' },
        pendingAuthorizationRequest: null,
        configuration,
        timeoutMs: 1_000,
      }),
      getPlannerConfiguration: () => configuration,
    } as never,
  });
  if (options.kernelExecutionRuntime !== null) {
    (session as unknown as { kernelExecutionRuntime: unknown }).kernelExecutionRuntime
      = options.kernelExecutionRuntime ?? { cancelTask };
  }
  return { session, trace, cancelPlannerTurn, submitKernel, cancelTask };
}

describe('turn cancellation', () => {
  it('aborts the Planner run, marks the turn cancelled and drops the late proposal', async () => {
    const plannerRun = deferred<void>();
    const { workGraphPlan } = await import('../support/planning-agent-plans.js');
    let lateProposal: { status: string; issues?: string[] } | null = null;
    const { session, trace, cancelPlannerTurn, submitKernel, cancelTask } = sessionWith({
      planning: {
        submit: async (_context: unknown, submitter: { submit: (plan: unknown) => Promise<unknown> }) => {
          await plannerRun.promise;
          // The Planner keeps working after the abort and submits late.
          lateProposal = await submitter.submit(workGraphPlan({ goal: 'late work' })) as never;
          return lateProposal as never;
        },
      } as never,
    });

    // Drives the real command path, which is what registers the turn identity
    // the Client cancels by.
    const planning = session.executeGatewayCommand(
      { kind: 'user_message', text: '帮我做一个很长的任务' },
      { interactionTurnId: 'turn_cancel_1' },
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(trace.getSnapshot()?.events.some(event => event.kind === 'planner_started')).toBe(true);
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_cancel_1' });

    expect(cancelPlannerTurn).toHaveBeenCalledWith('planner_cancel');
    expect(cancelTask).toHaveBeenCalledWith('task_x', '用户取消了当前轮');

    // The aborted Planner run submits afterwards; the latch must drop it.
    plannerRun.resolve();
    await planning;

    expect(lateProposal).toMatchObject({ status: 'rejected', issues: ['turn cancelled by user'] });
    expect(submitKernel).not.toHaveBeenCalled();
    const snapshot = trace.getSnapshot();
    expect(snapshot?.status).toBe('cancelled');
    expect(snapshot?.events.some(event => event.kind === 'turn_cancelled')).toBe(true);
  });

  it('refuses to cancel a turn that is not the active one', async () => {
    const plannerRun = deferred<never>();
    const { session, trace, cancelPlannerTurn } = sessionWith({
      planning: { submit: async () => plannerRun.promise } as never,
    });

    const planning = session.executeGatewayCommand(
      { kind: 'user_message', text: '任务' },
      { interactionTurnId: 'turn_cancel_2' },
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(trace.getSnapshot()?.events.some(event => event.kind === 'planner_started')).toBe(true);
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_other' });
    expect(cancelPlannerTurn).not.toHaveBeenCalled();

    plannerRun.reject(new Error('test cleanup'));
    await planning;
  });

  it('cancels the Conversation Task when no Planner turn is in flight', async () => {
    const { session, cancelPlannerTurn, cancelTask } = sessionWith({
      planning: { submit: async () => ({ status: 'accepted' }) as never } as never,
    });

    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn_gone' });

    expect(cancelPlannerTurn).not.toHaveBeenCalled();
    expect(cancelTask).toHaveBeenCalledWith('task_x', '用户取消了当前轮');
  });
});
