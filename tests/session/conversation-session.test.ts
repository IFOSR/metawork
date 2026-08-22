import { describe, expect, it } from 'vitest';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';
import type { PlannerTuiPermissionRequest } from '../../src/session/session-types.js';

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

function makePort(
  accountId: string,
  overrides: Partial<ConversationRuntimePort> = {},
): ConversationRuntimePort {
  const base: ConversationRuntimePort = {
    accountId,
    planning: null,
    permissions: null,
    queries: {
      findTask: () => null,
      listTasks: () => [],
      listTasksByStatus: () => [],
      listSubtasks: () => [],
      findSubtask: () => null,
      findKernelEvent: () => null,
      findKernelApplicationByDecisionId: () => null,
      listKernelDecisionsBySession: () => [],
      listKernelDecisionsByTask: () => [],
      listCurrentKernelDecisions: () => [],
      listExecutorStatuses: () => [],
      listWorkGraphTaskIds: () => [],
      findOldestPendingPermission: () => null,
      listIntegratedPublications: () => [],
      listRecoveryApplications: () => [],
      findRecoveryApplication: () => null,
      listRecoveryEffects: () => [],
      findRecoveryEffect: () => null,
      findActiveWorkGraphRevision: () => null,
      listTaskEvidence: () => [],
      listAttemptReceipts: () => [],
    },
    commands: {
      submitKernel: mockCoordinator().submit,
      materializeCompletedEvidence: () => undefined,
      resolveRecoveryApplication: () => undefined,
      resolveRecoveryEffect: () => undefined,
      refreshExecutors: async input => ({
        configurationRevision: 'revision-test',
        trigger: input.trigger,
        checked: [],
        recovered: [],
        stillError: [],
        skipped: [],
      }),
    },
    execution: null,
  };
  return {
    ...base,
    ...overrides,
    queries: { ...base.queries, ...overrides.queries },
    commands: { ...base.commands, ...overrides.commands },
  };
}

function makeSession(
  conversationId: string,
  plannerSessionId: string,
  accountId = 'local-default',
  runtimePort = makePort(accountId),
) {
  return new ConversationSession({
    conversationId,
    plannerSessionId,
    runtimePort,
    mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
  });
}

describe('ConversationSession', () => {
  it('qualifies the current user input for initial Work Graph admission', () => {
    const session = new ConversationSession({
      conversationId: 'conv_context_ref',
      plannerSessionId: 'planner_context_ref',
      runtimePort: makePort('local-default'),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      planningContextBuilder: {
        getPlannerConfiguration: () => ({ revisionId: 'revision-test' }),
      } as never,
      kernelConfiguration: { revisionId: 'revision-test' } as never,
    });

    const snapshot = session.buildPlanAdmissionSnapshot({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      type: 'plan_proposed',
      id: 'plan_event_context_ref',
      correlationId: 'plan_context_ref',
      causationId: null,
      occurredAt: '2026-08-20T00:00:00.000Z',
      sessionId: 'planner_context_ref',
      proposal: {
        task: { taskId: null },
        workGraph: {
          subtasks: [{
            contextRefs: [{ kind: 'current_user_input' }],
          }],
        },
      },
      requestText: '分析昨晚黄金期货上涨的原因',
      generationId: 'generation_context_ref',
      proposalSource: 'initial',
      targetGraphRevision: 1,
    } as never);

    expect(snapshot?.eligibleContextRefKeys).toEqual(['current_user_input']);
  });

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
    const receipt = session.submitCommand({ requestId: 'req_1', idempotencyKey: 'idem_1' });
    expect(receipt.status).toBe('accepted');
  });

  it('projects only permission requests owned by its Planner session', () => {
    const request = permissionRequest('permission_1');
    const session = makeSession(
      'conv_1',
      'planner_1',
      'local-default',
      makePort('local-default', {
        permissions: {
          listForSession: sessionId => sessionId === 'planner_1' ? [request] : [],
          resolve: async () => ({
            status: 'resolved',
            resolution: 'approve',
            message: 'resolved',
            recoveryTaskId: null,
          }),
        },
      }),
    );

    expect(session.getPlannerTuiPermissionRequests()).toEqual([request]);
  });

  it('resolves Gateway permission commands through the account permission facade', async () => {
    const resolutions: unknown[] = [];
    const session = makeSession(
      'conv_1',
      'planner_1',
      'local-default',
      makePort('local-default', {
        permissions: {
          listForSession: () => [],
          resolve: async input => {
            resolutions.push(input);
            return {
              status: 'resolved',
              resolution: input.resolution,
              message: 'Permission resolution recorded.',
              recoveryTaskId: null,
            };
          },
        },
      }),
    );

    await session.executeGatewayCommand({
      kind: 'permission_resolution',
      requestId: 'permission_1',
      resolution: 'deny',
    });

    expect(resolutions).toEqual([{
      sessionId: 'planner_1',
      requestId: 'permission_1',
      resolution: 'deny',
      source: 'button',
      plannerPlanId: null,
    }]);
  });

  it('surfaces Planner transport failures instead of reporting a no-action fallback', async () => {
    const trace = new InteractionTraceStream('planner_1');
    const session = new ConversationSession({
      conversationId: 'conv_1',
      plannerSessionId: 'planner_1',
      runtimePort: makePort('local-default', {
        queries: {
          findOldestPendingPermission: () => null,
        } as never,
        planning: {
          submit: async (_context, submitter) => {
            submitter.onProgress?.({
              kind: 'process_started',
              sequence: 1,
              elapsedMs: 5,
            });
            submitter.onProgress?.({
              kind: 'model_waiting',
              turn: 1,
              idleMs: 15_000,
              sequence: 2,
              elapsedMs: 15_000,
            });
            return {
              status: 'transport_uncertain',
              turnId: 'turn_1',
              submissionId: 'submission_1',
              retryableByReplay: true,
              message: 'Planner unavailable: bridge disconnected',
            };
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream: trace,
      planningContextBuilder: {
        build: ({ userInput }: { userInput: string }) => ({
          userInput,
          request: { sessionId: 'planner_1', source: 'session' },
          pendingAuthorizationRequest: null,
          configuration: {
            revisionId: 'revision-test',
            contentHash: 'hash',
            models: [],
            routingCatalog: {
              configurationRevision: 'revision-test',
              agentClasses: [],
            },
          },
          timeoutMs: 1_000,
        }),
      } as never,
    });

    await session.submitUserInput('hello', { interactionTurnId: 'gateway_turn_1' });

    expect(session.getOutput().at(-1)).toBe('错误: Planner unavailable: bridge disconnected');
    expect(session.getOutput()).not.toContain('-> ControlKernel did not produce a runtime action.');
    expect(session.getInteractionTrace()).toMatchObject({
      turnId: 'gateway_turn_1',
      status: 'blocked',
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'query_received' }),
        expect.objectContaining({ kind: 'planner_started' }),
        expect.objectContaining({ kind: 'planner_process_started' }),
        expect.objectContaining({ kind: 'planner_model_waiting' }),
        expect.objectContaining({ kind: 'proposal_transport_uncertain' }),
      ]),
    });
  });
});

function permissionRequest(permissionRequestId: string): PlannerTuiPermissionRequest {
  return {
    schemaVersion: 1,
    permissionRequestId,
    taskId: 'task_1',
    taskTitle: 'Task 1',
    generationId: 'generation_1',
    subtaskId: 'subtask_1',
    subtaskTitle: 'Subtask 1',
    attemptId: 'attempt_1',
    executorName: 'codex-cli',
    permissionProfileId: 'workspace-engineering',
    capability: 'external_object_operation',
    resource: 'example',
    operation: 'write',
    reason: 'needed',
    suggestedScope: 'once',
    escalationReason: 'requires approval',
    createdAt: '2026-08-19T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
  };
}
