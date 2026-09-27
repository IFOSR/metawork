import { describe, expect, it, vi } from 'vitest';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import { SpanEvaluationAbortedError, type SpanRoutingEvaluator } from '../../src/routing/span-routing-types.js';

/**
 * Session-level regressions found in review:
 *  - cancellation during Span evaluation must not admit the proposal;
 *  - a resubmitted event that is already durable must not be scored twice.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const configuration = {
  revisionId: 'rev',
  contentHash: 'hash',
  runtimePolicy: {},
  providers: { p: { enabled: true } },
  models: {
    m1: { providerRef: 'p', modelId: 'gpt-m1', capabilities: ['coding', 'tools'], enabled: true },
    m2: { providerRef: 'p', modelId: 'gpt-m2', capabilities: ['coding', 'tools'], enabled: true },
  },
  agentClasses: {
    executor: {
      kind: 'executor', harnessRef: 'h', driverId: 'codex-cli',
      modelPolicy: { mode: 'auto', allowedModelRefs: ['m1', 'm2'] },
      permissionProfileRef: 'workspace', routingCapabilities: ['workspace-engineering'], enabled: true,
    },
  },
  permissionProfiles: {
    workspace: { profileId: 'workspace-engineering', version: 1, parameters: {} },
  },
} as never;

const plan = {
  id: 'plan',
  action: 'plan_work_graph',
  task: { taskId: null, goal: 'Implement parser' },
  workGraph: {
    schemaVersion: 7,
    configurationRevision: 'rev',
    reason: 'test',
    subtasks: [{
      id: 's1',
      title: 'Implement parser',
      goal: 'Implement parser',
      contextRefs: [],
      dependencies: [],
      requiredCapabilities: ['workspace-engineering'],
      riskLevel: 'low',
      acceptance: [],
      executorBindings: [{ agentClassRef: 'executor', modelSelection: { mode: 'agent-class-default' } }],
    }],
  },
} as never;

type EvaluateInput = Parameters<SpanRoutingEvaluator['evaluate']>[0];

function fixture(evaluate: SpanRoutingEvaluator['evaluate']) {
  const trace = new InteractionTraceStream('conv');
  const persisted = new Map<string, unknown>();
  const submitKernel = vi.fn(async (event: { id: string }) => {
    if (!persisted.has(event.id)) persisted.set(event.id, event);
    return {
      decisions: [{
        id: `decision_${event.id}`,
        eventId: event.id,
        action: { type: 'authorize_task_plan', taskId: 'task_1' },
        reason: 'authorized',
      }],
      quiescent: true,
      pendingRecovery: 0,
    };
  });
  const port = {
    accountId: 'local-default',
    planning: null,
    permissions: null,
    execution: null,
    queries: {
      findTask: () => null,
      listTasks: () => [],
      listKernelDecisionsBySession: () => [],
      findKernelApplicationByDecisionId: () => ({ status: 'applied' }),
      findOldestPendingPermission: () => null,
      findKernelEvent: (id: string) => persisted.get(id) ?? null,
      listTaskEvidence: () => [],
      listAttemptReceipts: () => [],
      listKernelDecisionsByTask: () => [],
      findActiveWorkGraphRevision: () => null,
    },
    commands: {
      submitKernel,
      cancelPlannerTurn: async () => undefined,
      materializeCompletedEvidence: () => undefined,
    },
  };
  const session = new ConversationSession({
    conversationId: 'conv',
    plannerSessionId: 'planner',
    mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
    interactionTraceStream: trace,
    runtimePort: port as never,
    kernelConfiguration: configuration,
    planningContextBuilder: {
      getPlannerConfiguration: () => ({ revisionId: 'rev' }),
      build: () => ({ configuration: { revisionId: 'rev' } }),
    } as never,
    getRuntimeConfiguration: () => ({ routing: { span: { enabled: true, timeoutMs: 3_000 } } }) as never,
    spanRoutingEvaluator: { evaluate },
    sessionKernelRuntime: { forInput: () => ({ apply: async () => null }) } as never,
  });
  vi.spyOn(session, 'buildPlanAdmissionSnapshot')
    .mockReturnValue({ executorStatuses: [] } as never);
  const internal = session as unknown as {
    activeInteractionTurnId: string | null;
    submitValidatedPlannerProposal: (
      userInput: string,
      plan: unknown,
      eventId: string,
    ) => Promise<{ status: string; issues?: string[] }>;
    requestKernelReplan: (decision: unknown) => Promise<unknown>;
    requestKernelMergeReplan: (decision: unknown) => Promise<unknown>;
    runPlanningAgent: (context: unknown) => Promise<unknown>;
  };
  internal.activeInteractionTurnId = 'turn';
  internal.runPlanningAgent = async () => plan;
  trace.beginTurn({ turnId: 'turn', userInput: 'Implement parser' });
  return { session, internal, submitKernel, port };
}

function replanDecision(type: 'request_replan' | 'request_merge_replan') {
  return {
    schemaVersion: 5,
    configurationRevision: 'rev',
    id: `decision_${type}`,
    eventId: 'event_origin',
    reason: 'generation is quiescent',
    action: type === 'request_replan'
      ? { type, taskId: 'task_1', generationId: 'gen_1', sourceRevision: 1 }
      : { type, taskId: 'task_1', subtaskId: 's1', publicationId: 'pub_1', conflictChainId: 'chain_1' },
  };
}

/** Wires the durable Task facts a replan needs before it reaches Span. */
function withReplanTask(port: { queries: Record<string, unknown> }): void {
  port.queries.findTask = () => ({ id: 'task_1', goal: 'Task goal' });
  port.queries.findActiveWorkGraphRevision = () => ({ generationId: 'gen_1', revision: 1 });
}

describe('ConversationSession Span integration', () => {
  it('does not admit the proposal when the Turn is cancelled during Span evaluation', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const evaluate = vi.fn(async (input: EvaluateInput) => {
      observedSignal = input.signal;
      entered.resolve();
      await release.promise;
      return { subtasks: [] };
    });
    const { session, internal, submitKernel } = fixture(evaluate);

    const submission = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await entered.promise;
    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });
    release.resolve();
    const result = await submission;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(submitKernel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'rejected',
      issues: ['turn cancelled by user'],
    });
  });

  it('scores a proposal once and reuses the durable event on uncertain resubmission', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const { internal } = fixture(evaluate);

    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    expect(evaluate).toHaveBeenCalledTimes(1);

    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    // Replay must reuse the stored event instead of paying for a second request.
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('passes the pinned configuration revision to the advisor', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const { internal } = fixture(evaluate);

    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');

    expect(evaluate.mock.calls[0]?.[0].configurationRevision).toBe('rev');
  });

  it.each(['request_replan', 'request_merge_replan'] as const)(
    'abandons %s when the Turn is cancelled during Span evaluation',
    async type => {
      const entered = deferred<void>();
      const evaluate: SpanRoutingEvaluator['evaluate'] = async input => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            reject(new SpanEvaluationAbortedError());
          }, { once: true });
        });
        return { subtasks: [] };
      };
      const { session, internal, port } = fixture(evaluate);
      withReplanTask(port);

      const evaluation = type === 'request_replan'
        ? internal.requestKernelReplan(replanDecision(type))
        : internal.requestKernelMergeReplan(replanDecision(type));
      await entered.promise;
      await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });

      // Cancellation must not hand the Runtime a persistable `plan_proposed`.
      await expect(evaluation).resolves.toBeNull();
    },
  );

  it('aborts in-flight Span work and refuses admission once the Session is disposed', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const evaluate = vi.fn(async (input: EvaluateInput) => {
      observedSignal = input.signal;
      entered.resolve();
      await release.promise;
      return { subtasks: [] };
    });
    const { session, internal } = fixture(evaluate);

    const submission = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await entered.promise;
    await session.dispose();

    expect(observedSignal?.aborted).toBe(true);
    release.resolve();
    await expect(submission).resolves.toMatchObject({
      status: 'rejected',
      issues: ['turn cancelled by user'],
    });
  });

  it('does not admit the proposal when the advisor reports a cancelled request', async () => {
    // The Server lifetime aborts in-flight requests without a Turn latch; a
    // cancelled request must still fail closed rather than submit unscored.
    const evaluate = vi.fn(async () => {
      throw new SpanEvaluationAbortedError();
    });
    const { internal, submitKernel } = fixture(evaluate);

    const result = await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');

    expect(submitKernel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'rejected' });
  });

  it('keeps the deterministic path when the advisor is aborted without a cancellation latch', async () => {
    const evaluate = vi.fn(async (input: EvaluateInput) => {
      input.signal?.dispatchEvent(new Event('abort'));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const { internal, submitKernel } = fixture(evaluate);

    // No cancel command: the Turn is still live, so the abort only drops the
    // optional ranking signal and admission proceeds deterministically.
    const result = await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');

    expect(result.status).toBe('accepted');
    expect(submitKernel).toHaveBeenCalledTimes(1);
    const submitted = submitKernel.mock.calls[0]?.[0] as { spanRouting?: unknown };
    expect(submitted.spanRouting).toBeUndefined();
  });
});
