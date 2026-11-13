import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PlanProposalRepo } from '../../src/storage/plan-proposal-repo.js';
import { SqliteTurnCancellationStore } from '../../src/storage/turn-cancellation-repo.js';
import type { TurnCancellationStore } from '../../src/session/turn-cancellation-store.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import type { PlanAdmissionRequest } from '../../src/execution/plan-admission-policy.js';

/**
 * Session-level regressions found in review:
 *  - cancellation during proposal preparation must not admit the proposal;
 *  - a resubmitted event that is already durable must not be prepared twice.
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
      kind: 'executor', harnessRef: 'h', driverId: 'pi-cli',
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
    }],
  },
} as never;

type EvaluateInput = { configurationRevision: string; signal: AbortSignal };
type PreparationHook = (input: EvaluateInput) => Promise<unknown>;

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(evaluate: PreparationHook, proposals?: PlanProposalRepo, turnCancellations?: TurnCancellationStore) {
  const db = new Database(':memory:');
  databases.push(db);
  proposals ??= new PlanProposalRepo(db);
  turnCancellations ??= new SqliteTurnCancellationStore(db, 'local-default');
  const trace = new InteractionTraceStream('conv');
  const persisted = new Map<string, unknown>();
  const submitControl = vi.fn(async (event: { id: string }) => {
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
    proposals,
    turnCancellations,
    planning: null,
    permissions: null,
    execution: null,
    queries: {
      findTask: () => null,
      listTasks: () => [],
      listControlDecisionsBySession: () => [],
      findControlApplicationByDecisionId: () => ({ status: 'applied' }),
      findOldestPendingPermission: () => null,
      findControlEvent: (id: string) => persisted.get(id) ?? null,
      listTaskEvidence: () => [],
      listAttemptReceipts: () => [],
      listControlDecisionsByTask: () => [],
      findActiveWorkGraphRevision: () => null,
    },
    commands: {
      submitControl,
      cancelPlannerTurn: async () => undefined,
      materializeCompletedEvidence: () => undefined,
    },
  };
  const forInput = vi.fn(() => ({ apply: async () => null }));
  // The producer now admits directly; the fake keeps routing through the
  // transport spy so transport-failure and call-count assertions still apply.
  const applyPlanAdmission = vi.fn(async (
    result: { status: string; reason: string },
    context: { proposalId: string },
  ) => {
    const transport = await submitControl({ id: context.proposalId }) as {
      decisions: Array<{ action: { type: string; taskId?: string } }>;
    };
    return {
      operationId: `admission_${context.proposalId}`,
      status: result.status === 'rejected' ? 'rejected' : 'authorized',
      taskId: transport.decisions[0]?.action.taskId ?? null,
      reason: result.reason,
      schedulingReason: null,
      displayText: null,
      replayed: false,
    };
  });
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
    sessionControlRuntime: { forInput, applyPlanAdmission } as never,
    // These tests cover Span preparation and Turn fencing, not the admission
    // policy: the transport spy above plays the ap.plier's role.
    evaluatePlanAdmission: (() => ({ status: 'authorized', reason: 'authorized', taskId: 'task_1' })) as never,
  });
  vi.spyOn(session, 'buildPlanAdmissionSnapshot').mockReturnValue({
    tasks: [],
    activeTaskByConversation: { conv: null },
    occupiedConversationIds: [],
    queuedTaskCountByConversation: { conv: 0 },
    activeTaskCount: 0,
    runningTaskId: null,
    plannerConfiguration: configuration,
    kernelConfiguration: configuration,
    executorStatuses: [],
    v5WorkGraphTaskIds: [],
    eligibleContextRefKeys: [],
    pendingAuthorizationRequest: null,
  } as never);
  // Delay the actual workspace/configuration preparation seam. Routing no
  // longer runs before admission; these tests retain Turn fencing coverage.
  const preparation = session as unknown as {
    prepareNewPlanProposal: (event: PlanAdmissionRequest, signal: AbortSignal) => Promise<PlanAdmissionRequest | null>;
  };
  const prepare = preparation.prepareNewPlanProposal.bind(session);
  vi.spyOn(preparation, 'prepareNewPlanProposal').mockImplementation(async (event, signal) => {
    await evaluate({ configurationRevision: event.configurationRevision, signal });
    return prepare(event, signal);
  });
  const internal = session as unknown as {
    activeInteractionTurnId: string | null;
    activeQueryId: string | null;
    submitValidatedPlannerProposal: (
      userInput: string,
      plan: unknown,
      eventId: string,
    ) => Promise<{ status: string; issues?: string[] }>;
    requestControlReplan: (decision: unknown) => Promise<unknown>;
    requestControlMergeReplan: (decision: unknown) => Promise<unknown>;
    runPlanningAgent: (context: unknown) => Promise<unknown>;
  };
  internal.activeInteractionTurnId = 'turn';
  internal.runPlanningAgent = async () => plan;
  trace.beginTurn({ turnId: 'turn', userInput: 'Implement parser' });
  return { session, internal, submitControl, port, forInput, applyPlanAdmission };
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

/** Wires the durable Task facts a replan needs before preparation. */
function withReplanTask(port: { queries: Record<string, unknown> }): void {
  port.queries.findTask = () => ({ id: 'task_1', goal: 'Task goal' });
  port.queries.findActiveWorkGraphRevision = () => ({ generationId: 'gen_1', revision: 1 });
}

describe('ConversationSession proposal preparation', () => {
  it('fences a saved proposal after cancellation and Session reconstruction with a fresh controller', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const first = fixture(evaluate);
    first.submitControl.mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(first.internal.submitValidatedPlannerProposal('Implement parser', plan, 'event')).rejects.toThrow('transport unavailable');
    await first.session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });
    await first.session.dispose();
    const restarted = fixture(evaluate, first.port.proposals, first.port.turnCancellations);
    const planner = vi.fn();
    restarted.internal.runPlanningAgent = planner;
    await expect(restarted.internal.submitValidatedPlannerProposal('Implement parser', plan, 'event'))
      .resolves.toMatchObject({ status: 'rejected', issues: ['turn cancelled by user'] });
    expect(restarted.submitControl).not.toHaveBeenCalled();
    expect(restarted.forInput).not.toHaveBeenCalled();
    expect(planner).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(first.port.proposals.find('event')?.delivery).toBe('pending');
  });

  it('does not acknowledge or abort when persisting the cancellation fails', async () => {
    const { session, port } = fixture(async () => ({ subtasks: [] }));
    const access = session as unknown as { turnCancellation: AbortController; cancelledTurnIds: Set<string> };
    const signal = access.turnCancellation.signal;
    vi.spyOn(port.turnCancellations, 'request').mockImplementation(() => { throw new Error('disk full'); });
    const cancelPlanner = vi.spyOn(port.commands, 'cancelPlannerTurn');
    await expect(session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' })).rejects.toThrow('disk full');
    expect(signal.aborted).toBe(false);
    expect(access.cancelledTurnIds.has('turn')).toBe(false);
    expect(cancelPlanner).not.toHaveBeenCalled();
    expect(port.turnCancellations.isRequested('conv', 'turn')).toBe(false);
  });

  it.each(['request_replan', 'request_merge_replan'] as const)(
    'rejects saved %s from a cancelled source Turn after rebuilding into another Turn', async type => {
      const evaluate = vi.fn(async () => ({ subtasks: [] }));
      const first = fixture(evaluate);
      withReplanTask(first.port);
      const method = type === 'request_replan' ? 'requestControlReplan' : 'requestControlMergeReplan';
      await first.internal[method](replanDecision(type));
      await first.session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });
      await first.session.dispose();
      const restarted = fixture(evaluate, first.port.proposals, first.port.turnCancellations);
      restarted.internal.activeInteractionTurnId = 'other_turn';
      withReplanTask(restarted.port);
      const planner = vi.fn();
      restarted.internal.runPlanningAgent = planner;
      await expect(restarted.internal[method](replanDecision(type))).rejects.toMatchObject({ code: 'turn_cancelled' });
      expect(planner).not.toHaveBeenCalled();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(restarted.submitControl).not.toHaveBeenCalled();
    },
  );

  it('reuses saved preparation after a failed handoff and Session reconstruction without a ledger reader', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const first = fixture(evaluate);
    first.internal.activeQueryId = 'query_original';
    first.port.queries.findControlEvent = () => { throw new Error('Kernel reader is forbidden'); };
    first.submitControl.mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(first.internal.submitValidatedPlannerProposal('Implement parser', plan, 'event')).rejects.toThrow('transport unavailable');
    const saved = first.port.proposals.find('event');
    expect(saved).toMatchObject({ delivery: 'pending', request: {
      sourceTurnId: 'turn', queryId: 'query_original',
    } });
    expect(saved?.request).not.toHaveProperty('type');
    await first.session.dispose();
    const restarted = fixture(evaluate, first.port.proposals);
    restarted.internal.activeQueryId = 'query_original';
    restarted.port.queries.findControlEvent = () => { throw new Error('Kernel reader is forbidden'); };
    await expect(restarted.internal.submitValidatedPlannerProposal('Implement parser', plan, 'event')).resolves.toMatchObject({ status: 'accepted' });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(restarted.port.proposals.find('event')).toMatchObject({ delivery: 'forwarded', request: saved?.request });
    expect(restarted.applyPlanAdmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userInput: 'Implement parser',
        conversationId: 'conv',
        queryId: 'query_original',
      }),
    );
  });

  it.each(['request_replan', 'request_merge_replan'] as const)('takes %s attachment eligibility only from the bound Task origin', async type => {
    const { internal, port } = fixture(async () => ({ subtasks: [] }));
    withReplanTask(port);
    port.queries.findControlEvent = () => { throw new Error('Kernel reader is forbidden'); };
    const origin = { id: '1', configurationRevision: 'rev', occurredAt: '2026-11-09T00:00:00.000Z',
      sessionId: 'planner', conversationId: 'conv', sourceTurnId: 'original_turn',
      proposal: { ...(plan as object), id: 'plan_origin' } as typeof plan,
      requestText: 'Original request', generationId: 'gen_1',
      proposalSource: 'initial' as const, targetGraphRevision: 1, attachmentIds: ['attachment_original'] };
    port.proposals.save({ request: origin });
    expect(port.proposals.findInitialForTask('task_1')).toBeNull();
    port.proposals.bindInitialToTask('task_1', origin.id);
    const method = type === 'request_replan' ? 'requestControlReplan' : 'requestControlMergeReplan';
    // The replan effect admits directly and returns no event; the eligibility
    // fact is the saved proposal's attachment set.
    await expect(internal[method](replanDecision(type))).resolves.toBeNull();
    const saved = port.proposals.find(
      `${type === 'request_replan' ? 'replan' : 'merge_replan'}_event_decision_${type}`,
    );
    expect(saved?.request.attachmentIds).toEqual(['attachment_original']);
    expect(port.proposals.find(saved!.request.id)?.delivery).toBe('forwarded');
  });

  it.each(['request_replan', 'request_merge_replan'] as const)('persists %s before returning and skips Manager and preparation after reconstruction', async type => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const first = fixture(evaluate);
    withReplanTask(first.port);
    const method = type === 'request_replan' ? 'requestControlReplan' : 'requestControlMergeReplan';
    const result = await first.internal[method](replanDecision(type));
    const id = `${type === 'request_replan' ? 'replan' : 'merge_replan'}_event_decision_${type}`;
    expect(result).toBeNull();
    expect(first.port.proposals.find(id)).toMatchObject({
      delivery: 'forwarded', triggerOperationId: `decision_${type}`,
    });
    await first.session.dispose();
    const restarted = fixture(evaluate, first.port.proposals);
    restarted.internal.runPlanningAgent = vi.fn(async () => { throw new Error('duplicate Manager call'); });
    restarted.port.queries.findControlEvent = () => { throw new Error('Kernel reader is forbidden'); };
    await expect(restarted.internal[method](replanDecision(type))).resolves.toBeNull();
    expect(restarted.internal.runPlanningAgent).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('refuses a different proposal under an already saved submission identity', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const first = fixture(evaluate);
    await first.internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    const restarted = fixture(evaluate, first.port.proposals);
    await expect(restarted.internal.submitValidatedPlannerProposal('Changed goal', plan, 'event')).rejects.toThrow('identity conflict');
    expect(restarted.submitControl).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('refuses a different generation under an already saved replan trigger', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const first = fixture(evaluate);
    withReplanTask(first.port);
    await first.internal.requestControlReplan(replanDecision('request_replan'));
    const restarted = fixture(evaluate, first.port.proposals);
    restarted.internal.runPlanningAgent = vi.fn(async () => { throw new Error('duplicate Manager call'); });
    const changed = replanDecision('request_replan');
    changed.action.generationId = 'different_generation';
    await expect(restarted.internal.requestControlReplan(changed)).rejects.toThrow('identity conflict');
    expect(restarted.internal.runPlanningAgent).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(['request_replan', 'request_merge_replan'] as const)('skips Planner and Span when %s is already cancelled', async type => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const { session, internal, port } = fixture(evaluate); withReplanTask(port);
    const planning = vi.spyOn(internal, 'runPlanningAgent');
    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });
    const result = type === 'request_replan'
      ? await internal.requestControlReplan(replanDecision(type))
      : await internal.requestControlMergeReplan(replanDecision(type));
    expect(result).toBeNull(); expect(planning).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('retains the prepared result while durable enqueue is still waiting', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const { internal, submitControl } = fixture(evaluate);
    const original = submitControl.getMockImplementation()!;
    const release = deferred<void>();
    submitControl.mockImplementation(async event => { await release.promise; return original(event); });
    const first = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await vi.waitFor(() => expect(submitControl).toHaveBeenCalledTimes(1));
    const second = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await vi.waitFor(() => expect(submitControl).toHaveBeenCalledTimes(2));
    release.resolve(); await Promise.all([first, second]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent submissions before the first event is durable', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const evaluate = vi.fn(async () => { entered.resolve(); await release.promise; return { subtasks: [] }; });
    const { internal } = fixture(evaluate);
    const first = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await entered.promise;
    const second = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await new Promise(resolve => setImmediate(resolve));
    release.resolve();
    await Promise.all([first, second]);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('rejects every coalesced submission when saving preparation fails', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const { internal, port, submitControl } = fixture(async () => {
      entered.resolve(); await release.promise; return { subtasks: [] };
    });
    const save = vi.spyOn(port.proposals, 'save').mockImplementation(() => { throw new Error('storage unavailable'); });
    const first = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await entered.promise;
    const second = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    const completed = Promise.allSettled([first, second]);
    release.resolve();
    expect(await completed).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'storage unavailable' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'storage unavailable' }) },
    ]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(submitControl).not.toHaveBeenCalled();
    expect(port.proposals.find('event')).toBeNull();
  });

  it('rejects changed proposals reusing the same durable event id', async () => {
    const { internal } = fixture(async () => ({ subtasks: [] }));
    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    const changed = structuredClone(plan) as any;
    changed.workGraph.subtasks[0].goal = 'Different work';
    await expect(internal.submitValidatedPlannerProposal('Implement parser', changed, 'event'))
      .rejects.toThrow(/identity|conflict/i);
  });

  it('cannot revive a cancelled evaluation when the next Turn replaces its controller', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const { session, internal, submitControl } = fixture(async () => {
      entered.resolve(); await release.promise; return { subtasks: [] };
    });
    const submission = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await entered.promise;
    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });
    const access = session as any;
    access.cancelledTurnIds.clear();
    access.activeInteractionTurnId = 'next-turn';
    access.turnCancellation = new AbortController();
    release.resolve();
    expect((await submission).status).toBe('rejected');
    expect(submitControl).not.toHaveBeenCalled();
  });

  it('does not admit the proposal when the Turn is cancelled during proposal preparation', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    const evaluate = vi.fn(async (input: EvaluateInput) => {
      observedSignal = input.signal;
      entered.resolve();
      await release.promise;
      return { subtasks: [] };
    });
    const { session, internal, submitControl, port } = fixture(evaluate);

    const submission = internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    await entered.promise;
    await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });
    release.resolve();
    const result = await submission;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(submitControl).not.toHaveBeenCalled();
    expect(port.proposals.find('event')).toBeNull();
    expect(result).toMatchObject({
      status: 'rejected',
      issues: ['turn cancelled by user'],
    });
  });

  it('prepares a proposal once and reuses the durable event on uncertain resubmission', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const { internal, session } = fixture(evaluate);

    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(session.getInteractionTrace()?.events.some(event => event.kind === 'span_routing_evaluated')).toBe(false);

    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');
    // Replay must reuse the stored event instead of paying for a second request.
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('passes the pinned configuration revision to preparation', async () => {
    const evaluate = vi.fn(async () => ({ subtasks: [] }));
    const { internal } = fixture(evaluate);

    await internal.submitValidatedPlannerProposal('Implement parser', plan, 'event');

    expect(evaluate.mock.calls[0]?.[0].configurationRevision).toBe('rev');
  });

  it.each(['request_replan', 'request_merge_replan'] as const)(
    'abandons %s when the Turn is cancelled during proposal preparation',
    async type => {
      const entered = deferred<void>();
      const evaluate: PreparationHook = async input => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('preparation cancelled'), { name: 'AbortError' }));
          }, { once: true });
        });
        return { subtasks: [] };
      };
      const { session, internal, port } = fixture(evaluate);
      withReplanTask(port);

      const evaluation = type === 'request_replan'
        ? internal.requestControlReplan(replanDecision(type))
        : internal.requestControlMergeReplan(replanDecision(type));
      await entered.promise;
      await session.executeGatewayCommand({ kind: 'cancel_turn', turnId: 'turn' });

      // Cancellation must not hand the Runtime a persistable `plan_proposed`.
      await expect(evaluation).resolves.toBeNull();
      const id = `${type === 'request_replan' ? 'replan' : 'merge_replan'}_event_decision_${type}`;
      expect(port.proposals.find(id)).toBeNull();
    },
  );

  it('aborts in-flight preparation work and refuses admission once the Session is disposed', async () => {
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

});
