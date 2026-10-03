import { vi } from 'vitest';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';

export function deferred<T>() {
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
      findActiveWorkGraphRevision: () => null,
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

export function sessionWith(options: {
  planning: ConversationRuntimePort['planning'];
  permissions?: ConversationRuntimePort['permissions'];
  queries?: Partial<ConversationRuntimePort['queries']>;
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
      permissions: options.permissions ?? null,
      commands: { cancelPlannerTurn, submitKernel: submitKernel as never },
      queries: {
        getConversationTaskSlot: () => ({ conversationId: 'conv_cancel', activeTaskId: 'task_x', state: 'occupied' }),
        ...options.queries,
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
