import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import { clientConnectionEventStreamId } from '../../src/gateway/client-connection-event-stream.js';
import type { EventJournal } from '../../src/gateway/event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import {
  completeWorkspaceNavigationCommand,
  createGatewayReadOnlyQueryHandler,
  type GatewayReadOnlyQueryHandlerDeps,
} from '../../src/gateway/read-only-query-handler.js';
import type {
  GatewayReadOnlyQuery,
  GatewayReadOnlyQueryContext,
} from '../../src/gateway/client-gateway.js';
import type { GatewayTaskViewSnapshot } from '../../src/gateway/task-view.js';
import type { BillQueryService } from '../../src/billing/bill-query-service.js';

class MemoryJournal implements EventJournal {
  readonly appended: GatewayEventEnvelope[] = [];
  private readonly sequences = new Map<string, number>();

  append(event: GatewayEventEnvelope): Promise<GatewayEventEnvelope> {
    this.appended.push(event);
    return Promise.resolve(event);
  }

  replay(): Promise<GatewayReplay> {
    return Promise.resolve({ lastSequence: 0, snapshot: [], deltas: [] });
  }

  reserveSequence(accountId: string, conversationId: string): Promise<number> {
    const key = `${accountId}${conversationId}`;
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    return Promise.resolve(next);
  }
}

function taskViewSnapshot(requestId: string, conversationId: string): GatewayTaskViewSnapshot {
  return {
    queryVersion: 'task_view_v1',
    requestId,
    targetConversationId: conversationId,
    turnId: 'turn_1',
    taskId: 'task_1',
    title: 'Task',
    status: 'running',
    goal: null,
    startedAt: '2026-09-19T00:00:00.000Z',
    completedAt: null,
    routing: null,
    subtasks: [],
    timeline: null,
    progressSummary: null,
    pendingPermission: null,
    artifacts: [],
    result: null,
    asOfSequence: 7,
  };
}

function createHarness(overrides: Partial<GatewayReadOnlyQueryHandlerDeps> = {}) {
  const subscriptions = new GatewaySubscriptions();
  const journal = new MemoryJournal();
  const events: GatewayEventEnvelope[] = [];
  const queries: string[] = [];
  const handler = createGatewayReadOnlyQueryHandler({
    subscriptions,
    journal,
    authorizeConversation: async () => true,
    completeCommand: input => {
      queries.push(`complete:${input.text}`);
      return {
        state: 'incomplete',
        suggestions: Array.from({ length: 60 }, (_, index) => ({
          value: `/cmd_${index}`,
          label: `/cmd_${index}`,
          description: 'candidate',
          replacement: { start: 0, end: input.text.length, text: `/cmd_${index}` },
        })),
        hint: null,
        error: null,
      };
    },
    getTaskView: async input => {
      queries.push(`view:${input.taskId}`);
      return taskViewSnapshot(input.requestId, input.conversationId);
    },
    ...overrides,
  });
  return { subscriptions, journal, events, queries, handler };
}

function billingStub(overrides: Partial<BillQueryService> = {}): BillQueryService {
  return {
    getQueryBill: () => null,
    getQueryBillForAccount: () => null,
    getQueryBillForTurn: () => null,
    getTurnBillUserView: () => null,
    listQueryBills: () => [],
    getTaskUsageSummary: () => ({
      taskId: 'task_1',
      finalizedMicroCoin: '0',
      pendingReconciliationMicroCoin: '0',
      inFlightMicroCoin: '0',
      queryCount: 0,
      confirmedDeductedMicroCoin: '0',
    }),
    getTaskUsageSummaryForAccount: () => null,
    getUsageSummary: accountId => ({
      accountId,
      finalizedMicroCoin: '0',
      pendingReconciliationMicroCoin: '0',
      inFlightMicroCoin: '0',
      billCount: 0,
      confirmedDeductedMicroCoin: '0',
    }),
    ...overrides,
  };
}

function context(scope: GatewayReadOnlyQueryContext['scope']): GatewayReadOnlyQueryContext {
  return {
    accountId: 'local-default',
    principalId: 'local:local-installation',
    connectionId: 'conn_1',
    requestId: 'req_1',
    scope,
  };
}

const conversationScope: GatewayReadOnlyQueryContext['scope'] = {
  kind: 'conversation',
  selection: { mode: 'attach', conversationId: 'conv_1' },
};

describe('gateway read-only query handler', () => {
  it('publishes bounded completions only on the requesting connection stream', async () => {
    const harness = createHarness();
    const streamId = clientConnectionEventStreamId('conn_1');
    harness.subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: streamId,
      listener: event => harness.events.push(event),
    });
    harness.subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      listener: event => harness.events.push(event),
    });

    const result = await harness.handler(
      { kind: 'complete_command', text: '/task', cursor: 5 },
      context(conversationScope),
    );

    expect(result).toEqual({ status: 'accepted', conversationId: 'conv_1' });
    // 只发布到 connection 流，不进入 Conversation 历史流。
    expect(harness.events).toHaveLength(1);
    const event = harness.events[0]!;
    expect(event.conversationId).toBe(streamId);
    expect(event.kind).toBe('command_completion');
    expect(event.requestId).toBe('req_1');
    expect(event.sequence).toBe(1);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.query_version ?? payload.queryVersion).toBeDefined();
    expect(payload.targetConversationId ?? payload.target_conversation_id).toBe('conv_1');
    // 候选按协议上限截断。
    const suggestions = payload.suggestions as unknown[];
    expect(suggestions).toHaveLength(50);
    // 不写持久 journal（补全草稿与候选不持久化）。
    expect(harness.journal.appended).toEqual([]);
  });

  it('uses a null target Conversation for workspace scope completions', async () => {
    const harness = createHarness();
    const streamId = clientConnectionEventStreamId('conn_1');
    harness.subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: streamId,
      listener: event => harness.events.push(event),
    });

    const result = await harness.handler(
      { kind: 'complete_command', text: '/wo' },
      context({ kind: 'workspace' }),
    );

    expect(result).toEqual({ status: 'accepted', conversationId: null });
    const payload = harness.events[0]!.payload as Record<string, unknown>;
    expect(payload.targetConversationId).toBeNull();
  });

  it('fails closed when the Conversation is not authorized', async () => {
    const harness = createHarness({
      authorizeConversation: async () => false,
    });
    const result = await harness.handler(
      { kind: 'complete_command', text: '/task' },
      context(conversationScope),
    );
    expect(result).toEqual({ status: 'rejected', reason: 'conversation_denied' });
    expect(harness.events).toEqual([]);
    expect(harness.queries).toEqual([]);
  });

  it('shares the connection stream sequence allocator across responses', async () => {
    const harness = createHarness();
    const streamId = clientConnectionEventStreamId('conn_1');
    harness.subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: streamId,
      listener: event => harness.events.push(event),
    });
    const command: GatewayReadOnlyQuery = { kind: 'complete_command', text: '/a' };
    await harness.handler(command, context({ kind: 'workspace' }));
    await harness.handler(command, context({ kind: 'workspace' }));
    expect(harness.events.map(event => event.sequence)).toEqual([1, 2]);
  });

  it('returns structured errors for unknown task views without publishing', async () => {
    const harness = createHarness({
      getTaskView: async () => ({ error: 'turn_task_mismatch' as const }),
    });
    const result = await harness.handler(
      {
        kind: 'get_task_view',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        taskId: 'task_1',
      },
      context(conversationScope),
    );
    expect(result).toEqual({
      status: 'rejected',
      conversationId: 'conv_1',
      reason: 'turn_task_mismatch',
    });
    expect(harness.events).toEqual([]);
  });

  it('publishes task view snapshots with the explicit target Conversation', async () => {
    const harness = createHarness();
    const streamId = clientConnectionEventStreamId('conn_1');
    harness.subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: streamId,
      listener: event => harness.events.push(event),
    });
    const result = await harness.handler(
      {
        kind: 'get_task_view',
        conversationId: 'conv_1',
        turnId: 'turn_1',
        taskId: 'task_1',
      },
      context(conversationScope),
    );
    expect(result).toEqual({ status: 'accepted', conversationId: 'conv_1' });
    const event = harness.events[0]!;
    expect(event.kind).toBe('task_view_snapshot');
    expect(event.conversationId).toBe(streamId);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.targetConversationId).toBe('conv_1');
    expect(payload.asOfSequence).toBe(7);
    expect(harness.journal.appended).toEqual([]);
  });

  it('does not publish a query bill from another account', async () => {
    const harness = createHarness({
      billing: billingStub({
        getQueryBill: () => ({
          billId: 'bill_1',
          queryId: 'query_1',
          taskId: null,
          state: 'finalized',
          assessedMicroCoin: '1',
          assessedIsFinal: true,
          externalState: 'not_exported',
          externalEntryId: null,
          confirmedDeductedMicroCoin: null,
          coverage: 'complete',
          coverageNote: null,
          platformAbsorption: null,
          lines: [],
          adjustments: [],
          finalizedAt: null,
        }),
        getQueryBillForAccount: () => null,
      }),
    });

    const result = await harness.handler(
      { kind: 'get_query_bill', queryId: 'query_1' },
      context({ kind: 'workspace' }),
    );

    expect(result).toEqual({ status: 'rejected', reason: 'query_bill_not_found' });
    expect(harness.events).toEqual([]);
  });

  it('publishes the three-state Turn bill view for turn queries', async () => {
    const calls: string[] = [];
    const harness = createHarness({
      billing: billingStub({
        getTurnBillUserView: (accountId, turnId, options) => {
          calls.push(`turn:${accountId}:${turnId}:${String(options?.liveFallback)}`);
          return {
            turnId,
            queryId: 'query_1',
            conversationId: 'conv_1',
            taskId: null,
            userStatus: 'unconfirmed',
            headline: '费用暂时无法确认',
            amountMicroCoin: null,
            amountIsFinal: false,
            diagnosticCode: 'query_not_finalized',
            diagnosticMessage: '请求仍在等待计量收束',
            observedUsageCount: 2,
            missingCategories: [],
            usageBreakdown: [],
            stageBreakdown: [],
            billId: null,
            finalizedAt: null,
            projectedAt: '2026-09-19T00:00:00.000Z',
          };
        },
      }),
    });
    const streamId = clientConnectionEventStreamId('conn_1');
    harness.subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: streamId,
      listener: event => harness.events.push(event),
    });

    const result = await harness.handler(
      { kind: 'get_query_bill_for_turn', turnId: 'turn_1' },
      context({ kind: 'workspace' }),
    );

    // 账单未终结时也不 404：流式客户端靠三态视图展示“等待计量收束”。
    expect(result).toEqual({ status: 'accepted' });
    expect(calls).toEqual(['turn:local-default:turn_1:true']);
    const event = harness.events[0]!;
    expect(event.kind).toBe('usage_billing_projection');
    expect(event.conversationId).toBe(streamId);
    const payload = event.payload as Record<string, unknown>;
    expect(payload.turnId).toBe('turn_1');
    expect((payload.turnBill as Record<string, unknown>).userStatus).toBe('unconfirmed');
  });

  it('uses the authenticated account for task and account summaries', async () => {
    const calls: string[] = [];
    const harness = createHarness({
      authorizeTask: async () => true,
      billing: billingStub({
        getTaskUsageSummaryForAccount: (accountId, taskId) => {
          calls.push(`task:${accountId}:${taskId}`);
          return {
            taskId,
            finalizedMicroCoin: '0',
            pendingReconciliationMicroCoin: '0',
            inFlightMicroCoin: '0',
            queryCount: 0,
            confirmedDeductedMicroCoin: '0',
          };
        },
        getUsageSummary: accountId => {
          calls.push(`account:${accountId}`);
          return {
            accountId,
            finalizedMicroCoin: '0',
            pendingReconciliationMicroCoin: '0',
            inFlightMicroCoin: '0',
            billCount: 0,
            confirmedDeductedMicroCoin: '0',
          };
        },
      }),
    });

    const taskResult = await harness.handler(
      { kind: 'get_task_usage_summary', taskId: 'task_1' },
      context({ kind: 'workspace' }),
    );
    const accountResult = await harness.handler(
      { kind: 'get_usage_summary', accountId: 'local-default' },
      context({ kind: 'workspace' }),
    );

    expect(taskResult.status).toBe('accepted');
    expect(accountResult.status).toBe('accepted');
    expect(calls).toEqual([
      'task:local-default:task_1',
      'account:local-default',
    ]);
  });
});

describe('workspace navigation completion', () => {
  it('completes navigation command names by prefix', () => {
    const completion = completeWorkspaceNavigationCommand('/wo');
    expect(completion.suggestions.map(item => item.value)).toEqual(['/workspace']);
    expect(completion.suggestions[0]!.replacement).toEqual({
      start: 0,
      end: 3,
      text: '/workspace',
    });
  });

  it('is inactive for non-command text and positions past the first token', () => {
    expect(completeWorkspaceNavigationCommand('hello').state).toBe('inactive');
    expect(completeWorkspaceNavigationCommand('/workspace /tmp', 12).state).toBe('inactive');
    expect(completeWorkspaceNavigationCommand('').state).toBe('inactive');
  });

  it('lists all navigation candidates for a bare slash', () => {
    const completion = completeWorkspaceNavigationCommand('/');
    expect(completion.suggestions.length).toBeGreaterThanOrEqual(4);
    expect(completion.state).toBe('incomplete');
  });
});
