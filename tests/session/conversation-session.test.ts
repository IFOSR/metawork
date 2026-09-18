import { describe, expect, it } from 'vitest';
import type { KernelDecision } from '../../src/kernel/control-kernel.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { ConversationInputMailbox } from '../../src/session/conversation-input-mailbox.js';
import { ConversationSession } from '../../src/session/conversation-session.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';
import type { ConversationRuntimePort } from '../../src/session/conversation-runtime-port.js';
import type { PlannerTuiPermissionRequest } from '../../src/session/session-types.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';
import {
  createPlannerProposalSubmissionId,
  plannerProposalFingerprint,
} from '../../src/planning/planner-proposal.js';
import type { ConversationWorkspaceSelection } from '../../src/workspace/conversation-workspace-service.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';

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
  it('projects runtime state from the current Conversation only', () => {
    const session = makeSession('conversation-a', 'planner-a', 'local-default', makePort('local-default', {
      queries: {
        listTasks: () => [
          {
            id: 'task-b', title: 'foreign task', goal: 'foreign task', status: 'running',
            conversationId: 'conversation-b',
          },
          {
            id: 'task-a', title: 'local task', goal: 'local task', status: 'ready',
            conversationId: 'conversation-a',
          },
        ] as never,
      } as never,
    }));

    session.refreshRuntimeState();

    expect(session.getSnapshot().runtimeState).toMatchObject({
      runningTaskId: null,
      readyTaskIds: ['task-a'],
    });
  });

  it('projects routing traces with the modelId from the binding revision', () => {
    const interactionTraceStream = new InteractionTraceStream('conv_routing_identity');
    interactionTraceStream.beginTurn({
      turnId: 'turn_routing_identity',
      userInput: '分析智谱下跌',
    });
    const session = new ConversationSession({
      conversationId: 'conv_routing_identity',
      plannerSessionId: 'planner_routing_identity',
      runtimePort: makePort('local-default', {
        queries: {
          listSubtasks: () => [{
            id: 'task_1_r1_research',
            title: '研究下跌原因',
          }] as never,
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream,
      getRuntimeConfiguration: revisionId => revisionId === 'revision-old'
        ? {
            revisionId,
            contentHash: 'sha256:old',
            providers: {
              'code-cli': {
                protocol: 'openai-compatible',
                baseUrl: 'https://www.code-cli.cn/v1',
                apiKeyRef: 'file-secret:anyfusion/code-cli',
                region: 'international',
                enabled: true,
              },
            },
            models: {
              'code-cli-5': {
                providerRef: 'code-cli',
                modelId: 'gpt-5.6-terra',
                capabilities: [],
                reasoning: 'high',
                enabled: true,
              },
            },
            harnesses: {
              'codex-cli': {
                kind: 'executor',
                transport: 'local-cli',
                command: 'codex',
                args: [],
                driverId: 'codex-cli',
                supportsProbe: true,
                supportsAbort: true,
                supportsContinuation: true,
                enabled: true,
              },
            },
          } as never
        : null,
    });

    session.recordKernelDecisionTrace({
      id: 'decision_1',
      eventId: 'event_1',
      configurationRevision: 'revision-old',
      reason: 'work graph authorized',
      action: {
        type: 'authorize_task_plan',
        taskId: 'task_1',
        task: { title: '分析智谱下跌', goal: '输出分析' },
        workGraph: { subtasks: [] },
        authorizedBindingsBySubtask: {
          task_1_r1_research: [{
            agentClassRef: 'codex-cli',
            harnessRef: 'codex-cli',
            providerRef: 'code-cli',
            modelRef: 'code-cli-5',
            permissionProfileRef: 'workspace-write',
            configurationRevision: 'revision-old',
          }],
        },
        generationId: 'generation_1',
        graphRevision: 1,
        proposalSource: 'initial',
      },
    } as never);

    const routed = interactionTraceStream.getSnapshot()?.events
      .find(item => item.kind === 'executor_routed');
    expect(routed?.details).toMatchObject({
      providerDisplayName: 'Code CLI',
      modelDisplayName: 'gpt-5.6-terra',
      executorDisplayName: '智能体 2',
    });
    expect(routed?.summary).toContain('Code CLI/gpt-5.6-terra');
    expect(routed?.summary).not.toContain('code-cli-5');
  });

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

  it('rejects semantic input before Planner when the Conversation has no Workspace', async () => {
    let plannerCalls = 0;
    const session = new ConversationSession({
      conversationId: 'conv_workspace_required',
      plannerSessionId: 'planner_workspace_required',
      runtimePort: makePort('local-default', {
        planning: {
          submit: async () => {
            plannerCalls += 1;
            throw new Error('Planner must not start');
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      workspace: {
        getWorkspace: async (): Promise<ConversationWorkspace | null> => null,
        execute: async () => ({
          status: 'rejected' as const,
          code: 'workspace_required' as const,
          message: 'workspace required',
        }),
        initializeDefault: async () => ({
          status: 'rejected' as const,
          code: 'workspace_required' as const,
          message: 'workspace required',
        }),
      },
    });

    await expect(session.executeGatewayCommand({
      kind: 'user_message',
      text: '分析当前项目',
      attachments: [],
    }, { rethrowErrors: true })).rejects.toThrow('workspace_required');
    expect(plannerCalls).toBe(0);
  });

  it('handles /help without calling Planner', async () => {
    let plannerCalls = 0;
    const session = makeSession(
      'conv_help',
      'planner_help',
      'local-default',
      makePort('local-default', {
        planning: {
          submit: async () => {
            plannerCalls += 1;
            throw new Error('Planner must not start');
          },
        } as never,
      }),
    );

    await expect(session.executeGatewayCommand({
      kind: 'slash_command',
      text: '/help',
    }, { rethrowErrors: true })).resolves.toBeUndefined();

    expect(plannerCalls).toBe(0);
  });

  it('rejects an invalid slash command without calling Planner', async () => {
    let plannerCalls = 0;
    const session = new ConversationSession({
      conversationId: 'conv_invalid_command',
      plannerSessionId: 'planner_invalid_command',
      runtimePort: makePort('local-default', {
        planning: {
          submit: async () => {
            plannerCalls += 1;
            throw new Error('Planner must not start');
          },
        } as never,
        execution: {
          activeExecutions: {},
          listExecutorAgentClassNames: () => [],
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      commandCatalog: createDefaultCommandCatalog(),
    });

    await expect(session.executeGatewayCommand({
      kind: 'slash_command',
      text: '/does-not-exist',
    }, { rethrowErrors: true })).rejects.toMatchObject({
      message: expect.stringContaining('未知命令节点: does-not-exist'),
      code: 'command_invalid',
    });

    expect(plannerCalls).toBe(0);
  });

  it('rejects automatic Workspace selection at the Conversation seam', async () => {
    const calls: string[] = [];
    const workspace: ConversationWorkspaceSelection = {
      workspaceId: 'workspace_repo_a',
      boundAt: '2026-08-27T00:00:00.000Z',
      boundByPrincipal: 'local:local-installation',
      path: '/repo-a',
      selectedAt: '2026-08-27T00:00:00.000Z',
      selectedByPrincipal: 'local:local-installation',
    };
    const session = new ConversationSession({
      conversationId: 'conv_workspace_default',
      plannerSessionId: 'planner_workspace_default',
      runtimePort: makePort('local-default'),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      workspace: {
        getWorkspace: async () => null,
        bindEmptyConversation: async (workspaceId, principalId) => {
          calls.push(`bind:${workspaceId}:${principalId}`);
          return { status: 'changed', workspace };
        },
      },
    });

    await expect(session.executeGatewayCommand({
      kind: 'slash_command',
      text: '/workspace /repo-a',
      workspaceMutation: 'initialize_if_unset',
    }, { principalId: 'local:local-installation' })).rejects.toThrow(
      'Workspace selection must be handled by ClientGateway',
    );

    expect(calls).toEqual([]);
  });

  it('does not execute explicit Workspace selection inside ConversationSession', async () => {
    const calls: string[] = [];
    const workspace: ConversationWorkspaceSelection = {
      workspaceId: 'workspace_repo_b',
      boundAt: '2026-08-27T00:00:00.000Z',
      boundByPrincipal: 'local:local-installation',
      path: '/repo-b',
      selectedAt: '2026-08-27T00:00:00.000Z',
      selectedByPrincipal: 'local:local-installation',
    };
    const session = new ConversationSession({
      conversationId: 'conv_workspace_explicit',
      plannerSessionId: 'planner_workspace_explicit',
      runtimePort: makePort('local-default'),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      workspace: {
        getWorkspace: async () => null,
        bindEmptyConversation: async (workspaceId, principalId) => {
          calls.push(`bind:${workspaceId}:${principalId}`);
          return { status: 'changed', workspace };
        },
      },
    });

    await session.executeGatewayCommand({
      kind: 'slash_command',
      text: '/workspace /repo-b',
    }, { principalId: 'local:local-installation' });

    expect(calls).toEqual([]);
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

  it('fails closed on Planner convergence exhaustion without creating a task', async () => {
    const trace = new InteractionTraceStream('planner_convergence');
    let submittedProposal = false;
    const session = new ConversationSession({
      conversationId: 'conv_convergence',
      plannerSessionId: 'planner_convergence',
      runtimePort: makePort('local-default', {
        queries: {
          findOldestPendingPermission: () => null,
        } as never,
        planning: {
          submit: async () => ({
            status: 'convergence_exhausted',
            turnId: 'turn_convergence',
            message: 'Planner did not converge within its bounded planning budget.',
            reason: 'processing_cycles',
            limit: 8,
            observed: 9,
          }),
        } as never,
        commands: {
          submitKernel: async () => {
            submittedProposal = true;
            throw new Error('convergence exhaustion must not submit a Kernel event');
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream: trace,
      planningContextBuilder: {
        build: ({ userInput }: { userInput: string }) => ({
          userInput,
          request: { sessionId: 'planner_convergence', source: 'session' },
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

    await session.submitUserInput('研究这个问题', { interactionTurnId: 'gateway_convergence' });

    expect(submittedProposal).toBe(false);
    expect(session.getOutput().at(-1)).toContain('本轮未创建任务');
    expect(session.getInteractionTrace()).toMatchObject({
      turnId: 'gateway_convergence',
      status: 'blocked',
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: 'planner_convergence_exhausted',
          status: 'blocked',
        }),
      ]),
    });
  });

  it('ends a clarification turn after notifying the user that more input is required', async () => {
    const trace = new InteractionTraceStream('planner_clarification');
    const session = new ConversationSession({
      conversationId: 'conv_clarification',
      plannerSessionId: 'planner_clarification',
      runtimePort: makePort('local-default', {
        planning: {
          submit: async (_context, submitter) => {
            submitter.onProgress?.({
              kind: 'agent_completed',
              sequence: 1,
              elapsedMs: 25,
            });
            return {
              status: 'accepted',
              turnId: 'planner_turn_clarification',
              submissionId: 'proposal_clarification',
              planId: 'plan_clarification',
              outcome: 'clarification_requested',
              displayText: '请补充需要比较的具体发言内容。',
              taskId: null,
              kernel: {
                decisionId: 'decision_clarification',
                action: 'request_clarification',
                reason: 'missing comparison context',
              },
            };
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream: trace,
      planningContextBuilder: {
        build: ({ userInput }: { userInput: string }) => ({
          userInput,
          request: { sessionId: 'planner_clarification', source: 'session' },
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

    await session.submitUserInput('谁的发言含金量最高？', {
      interactionTurnId: 'gateway_turn_clarification',
    });

    expect(session.getInteractionTrace()).toMatchObject({
      turnId: 'gateway_turn_clarification',
      status: 'completed',
      completedAt: expect.any(String),
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'planner_agent_completed' }),
        expect.objectContaining({
          kind: 'clarification_requested',
          status: 'completed',
          summary: '请补充需要比较的具体发言内容。',
        }),
      ]),
    });
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('starts a fresh interaction trace for an explicit task resume command', async () => {
    const trace = new InteractionTraceStream('planner_resume');
    let session!: ConversationSession;
    session = new ConversationSession({
      conversationId: 'conv_resume',
      plannerSessionId: 'planner_resume',
      runtimePort: makePort('local-default'),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream: trace,
      handleCommand: async () => {
        session.appendExecutionTrace({
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'completed',
          title: 'Executor completed',
          summary: '恢复任务已完成',
          details: {
            subtaskId: 'subtask_resume',
            attemptId: 'attempt_resume',
          },
          eventKey: 'attempt_resume:completed',
          taskId: 'task_resume',
          traceStatus: 'completed',
        });
        return false;
      },
    });

    await session.submitUserInput('/task resume task_resume', {
      interactionTurnId: 'gateway_resume_turn',
    });

    expect(session.getInteractionTrace()).toMatchObject({
      turnId: 'gateway_resume_turn',
      taskId: 'task_resume',
      status: 'completed',
      events: [
        expect.objectContaining({
          kind: 'query_received',
          summary: '/task resume task_resume',
        }),
        expect.objectContaining({
          kind: 'executor_progress',
          subtaskId: 'subtask_resume',
          attemptId: 'attempt_resume',
        }),
      ],
    });
  });

  it('registers background task work before launching it and keeps the command trace open', async () => {
    const release = deferred<void>();
    let observedRegistered = false;
    let session!: ConversationSession;
    const trace = new InteractionTraceStream('conversation_background_command');
    session = new ConversationSession({
      conversationId: 'conv_background_command',
      plannerSessionId: 'planner_background_command',
      runtimePort: makePort('local-default'),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream: trace,
      handleCommand: async () => {
        session.startBackgroundExecution('task_background', async () => {
          observedRegistered = session.hasBackgroundWork();
          await release.promise;
        });
        return false;
      },
    });

    await session.submitUserInput('/task resume task_background', {
      interactionTurnId: 'gateway_background_command',
    });

    expect(observedRegistered).toBe(true);
    expect(session.hasBackgroundWork()).toBe(true);
    expect(trace.getSnapshot()?.events.some(event => event.kind === 'command_completed')).toBe(false);

    release.resolve();
    for (let attempt = 0; attempt < 20 && session.hasBackgroundWork(); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it('keeps the current turn open while its durable Task waits for an automatic retry', () => {
    const task = {
      id: 'task_retry_wait',
      conversationId: 'conv_retry_wait',
      status: 'blocked',
      dependencies: [{
        taskId: 'task_retry_wait',
        type: 'kernel_retry',
        description: 'retry scheduled',
        status: 'waiting',
      }],
    };
    const session = new ConversationSession({
      conversationId: 'conv_retry_wait',
      plannerSessionId: 'planner_retry_wait',
      runtimePort: makePort('local-default', {
        queries: {
          findTask: taskId => taskId === task.id ? task as never : null,
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
    });
    session.setCurrentTaskId(task.id);

    expect(session.hasBackgroundWork()).toBe(true);
  });

  it('does not append a previous Task execution trace into a newer turn', () => {
    const trace = new InteractionTraceStream('conversation_trace_ownership');
    const session = new ConversationSession({
      conversationId: 'conv_trace_ownership',
      plannerSessionId: 'planner_trace_ownership',
      runtimePort: makePort('local-default'),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      interactionTraceStream: trace,
    });
    trace.beginTurn({ turnId: 'turn_a', userInput: '执行 A' });
    session.setCurrentTaskId('task_a');
    trace.beginTurn({ turnId: 'turn_b', userInput: '开始 B' });

    session.appendExecutionTrace({
      phase: 'execution',
      actor: 'executor',
      kind: 'executor_progress',
      status: 'running',
      title: 'A is still running',
      summary: 'late progress from A',
      details: {},
      eventKey: 'late-a',
      taskId: 'task_a',
    });

    expect(trace.getSnapshot()?.turnId).toBe('turn_b');
    expect(trace.getSnapshot()?.events.some(event => event.eventKey === 'late-a')).toBe(false);
  });

  it('passes Gateway image attachments into the Planner context', async () => {
    let receivedContext: PlanningContext | null = null;
    const session = new ConversationSession({
      conversationId: 'conv_images',
      plannerSessionId: 'planner_images',
      runtimePort: makePort('local-default', {
        planning: {
          submit: async (context) => {
            receivedContext = context;
            return {
              status: 'transport_uncertain',
              turnId: 'turn_images',
              submissionId: 'submission_images',
              retryableByReplay: true,
              message: 'stop after context capture',
            };
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      planningContextBuilder: {
        build: (input: {
          userInput: string;
          images?: PlanningContext['images'];
        }) => ({
          userInput: input.userInput,
          images: input.images,
          request: { sessionId: 'planner_images', source: 'gateway' },
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

    const images = [{
      name: 'screenshot.jpg',
      mimeType: 'image/jpeg',
      data: 'base64-image-data',
    }];

    await session.executeGatewayCommand(
      { kind: 'user_message', text: '请分析这张图' },
      { images, rethrowErrors: false },
    );

    expect(receivedContext?.images).toEqual(images);
  });

  it('keeps the current Turn attachments eligible when the Planner submits through the bridge', async () => {
    const db = new (await import('better-sqlite3')).default(':memory:');
    const { runMigrations } = await import('../../src/storage/migrations.js');
    const { PlannerProposalRepo } = await import('../../src/storage/planner-proposal-repo.js');
    const { workGraphPlan } = await import('../support/planning-agent-plans.js');
    runMigrations(db);
    // planner_proposal_submissions.configuration_revision references this table.
    db.prepare(`
      INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
      VALUES ('revision-test', 'hash', 'native', ?)
    `).run(new Date(0).toISOString());
    const proposalRepo = new PlannerProposalRepo(db);
    const sessionId = 'planner_bridge_attachments';
    const turnId = 'turn_bridge_attachments';
    // The native Planner submits its proposal through the host bridge while the
    // planning run is still in flight, so the session must rebuild the same
    // eligible attachment set the Planner was given.
    const plan = workGraphPlan({
      goal: '分析这两份材料',
      contextRefs: [{ kind: 'attachment', attachmentId: 'att_current' }],
    });
    const configuration = {
      revisionId: 'revision-test',
      contentHash: 'hash',
      models: [{ id: 'codex-model', capabilities: ['coding', 'tools'], reasoning: 'high', region: 'international' }],
      routingCatalog: {
        version: 2,
        configurationRevision: 'revision-test',
        capabilities: [{ id: 'workspace-engineering', deliveryContract: 'Modify and verify workspace files.' }],
        agentClasses: [{
          id: 'codex-cli',
          routingCapabilities: ['workspace-engineering'],
          primaryUseCases: ['workspace implementation'],
          avoidUseCases: [],
          affordances: ['workspace-read-write', 'workspace-command-validation'],
          modelPolicy: { mode: 'fixed', modelRef: 'codex-model' },
        }],
      },
    };
    const submittedEvents: Array<{ attachmentIds?: string[] }> = [];
    let session!: ConversationSession;
    session = new ConversationSession({
      conversationId: 'conversation_bridge_attachments',
      plannerSessionId: sessionId,
      runtimePort: makePort('local-default', {
        planning: {
          submit: async (context: PlanningContext) => {
            const submissionId = createPlannerProposalSubmissionId(sessionId, turnId, plan);
            await session.submitPlannerProposal({
              sessionId,
              turnId,
              userInput: context.userInput,
              submissionId,
              plan,
            });
            return {
              status: 'transport_uncertain',
              turnId,
              submissionId,
              retryableByReplay: true,
              message: 'stop after the bridge submission',
            };
          },
        } as never,
        commands: {
          submitKernel: async (event: { attachmentIds?: string[] }) => {
            submittedEvents.push(event);
            return { decisions: [], quiescent: true, pendingRecovery: 0 };
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      plannerProposalRepo: proposalRepo,
      planningContextBuilder: {
        build: (input: {
          userInput: string;
          attachments?: PlanningContext['attachments'];
        }) => ({
          userInput: input.userInput,
          ...(input.attachments && input.attachments.length > 0
            ? { attachments: input.attachments }
            : {}),
          request: { sessionId, source: 'gateway' },
          pendingAuthorizationRequest: null,
          configuration,
          timeoutMs: 1_000,
        }),
        getPlannerConfiguration: () => configuration,
      } as never,
      sessionKernelRuntime: {
        forInput: () => ({ apply: async () => null }),
      } as never,
      db,
    });

    await session.handleNaturalLanguageInput('分析这两份材料', undefined, [{
      attachmentId: 'att_current',
      name: '菜单.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 1024,
      availability: 'available',
    }]).catch(() => undefined);

    expect(submittedEvents).toHaveLength(1);
    expect(submittedEvents[0]!.attachmentIds).toEqual(['att_current']);
    db.close();
  });

  it('keeps the Turn attachments eligible when the bridge submission comes from a restarted process', async () => {
    const db = new (await import('better-sqlite3')).default(':memory:');
    const { runMigrations } = await import('../../src/storage/migrations.js');
    const { PlannerProposalRepo } = await import('../../src/storage/planner-proposal-repo.js');
    const { workGraphPlan } = await import('../support/planning-agent-plans.js');
    runMigrations(db);
    db.prepare(`
      INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
      VALUES ('revision-test', 'hash', 'native', ?)
    `).run(new Date(0).toISOString());
    const proposalRepo = new PlannerProposalRepo(db);
    const conversationId = 'conversation_restart_attachments';
    const sessionId = 'planner_restart_attachments';
    const turnId = 'turn_restart_attachments';
    const plan = workGraphPlan({
      goal: '分析这两份材料',
      contextRefs: [{ kind: 'attachment', attachmentId: 'att_current' }],
    });
    const configuration = replanConfiguration();
    const submittedEvents: Array<{ attachmentIds?: string[] }> = [];
    const planningContextBuilder = {
      build: (input: {
        userInput: string;
        attachments?: PlanningContext['attachments'];
      }) => ({
        userInput: input.userInput,
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
        request: { sessionId, source: 'gateway' },
        pendingAuthorizationRequest: null,
        configuration,
        timeoutMs: 1_000,
      }),
      getPlannerConfiguration: () => configuration,
    };

    // The process that owns the bridge socket: a different ConversationSession
    // instance with no in-flight Turn of its own.
    const bridgeSession = new ConversationSession({
      conversationId,
      plannerSessionId: sessionId,
      runtimePort: makePort('local-default', {
        commands: {
          submitKernel: async (event: { attachmentIds?: string[] }) => {
            submittedEvents.push(event);
            return { decisions: [], quiescent: true, pendingRecovery: 0 };
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      plannerProposalRepo: proposalRepo,
      planningContextBuilder: planningContextBuilder as never,
      sessionKernelRuntime: {
        forInput: () => ({ apply: async () => null }),
      } as never,
      db,
    });

    // The process that started the Turn and then died mid-run.
    const turnSession = new ConversationSession({
      conversationId,
      plannerSessionId: sessionId,
      runtimePort: makePort('local-default', {
        planning: {
          submit: async (context: PlanningContext) => {
            await bridgeSession.submitPlannerProposal({
              sessionId,
              turnId,
              userInput: context.userInput,
              submissionId: createPlannerProposalSubmissionId(sessionId, turnId, plan),
              plan,
            });
            return {
              status: 'transport_uncertain',
              turnId,
              submissionId: 'submission_restart',
              retryableByReplay: true,
              message: 'stop after the bridge submission',
            };
          },
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      plannerProposalRepo: proposalRepo,
      planningContextBuilder: planningContextBuilder as never,
      db,
    });

    await turnSession.handleNaturalLanguageInput('分析这两份材料', undefined, [{
      attachmentId: 'att_current',
      name: '菜单.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 1024,
      availability: 'available',
    }]).catch(() => undefined);

    expect(submittedEvents).toHaveLength(1);
    expect(submittedEvents[0]!.attachmentIds).toEqual(['att_current']);
    db.close();
  });

  it('lets a replan reference the attachments its originating Turn was admitted with', async () => {
    const { workGraphPlan } = await import('../support/planning-agent-plans.js');
    const configuration = replanConfiguration();
    const session = new ConversationSession({
      conversationId: 'conversation_replan_attachments',
      plannerSessionId: 'planner_replan_attachments',
      runtimePort: makePort('local-default', {
        planning: {
          plan: async () => workGraphPlan({
            goal: 'remaining work',
            contextRefs: [{ kind: 'attachment', attachmentId: 'att_original' }],
          }),
        } as never,
        queries: {
          findTask: () => ({
            id: 'task_1',
            title: 'Task',
            goal: 'Task goal',
            status: 'running',
            conversationId: 'conversation_replan_attachments',
          }) as never,
          listKernelDecisionsByTask: () => ([{
            eventId: 'event_original_admission',
            eventType: 'plan_proposed',
          }]) as never,
          findKernelEvent: () => ({
            type: 'plan_proposed',
            attachmentIds: ['att_original'],
          }) as never,
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      planningContextBuilder: {
        build: (input: { userInput: string }) => ({
          userInput: input.userInput,
          request: { sessionId: 'planner_replan_attachments', source: 'session' },
          pendingAuthorizationRequest: null,
          configuration,
          timeoutMs: 1_000,
        }),
      } as never,
    });

    const event = await session.getKernelExecutionCallbacks().kernelExecutionCallbacks.requestReplan({
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision_replan',
      eventId: 'event_replan_request',
      action: {
        type: 'request_replan',
        taskId: 'task_1',
        generationId: 'generation_1',
        sourceRevision: 1,
      },
      reason: 'generation is quiescent',
    } as never);

    expect(event).toMatchObject({
      type: 'plan_proposed',
      proposalSource: 'replan',
      attachmentIds: ['att_original'],
      targetGraphRevision: 2,
    });
  });

  it('reconstructs an accepted proposal from an already-applied Kernel decision after a completion crash', async () => {
    const db = new (await import('better-sqlite3')).default(':memory:');
    const { runMigrations } = await import('../../src/storage/migrations.js');
    const { PlannerProposalRepo } = await import('../../src/storage/planner-proposal-repo.js');
    runMigrations(db);
    const proposalRepo = new PlannerProposalRepo(db);
    const plan = {
      schemaVersion: 8,
      id: 'plan_replay_applied',
      action: 'direct_reply',
      confidence: 0.9,
      reason: 'recover applied proposal',
      clarificationQuestion: null,
      response: { directReply: 'already delivered' },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
      risk: { level: 'low', requiresConfirmation: false, reasons: [] },
      authorizationResolution: null,
      workGraph: null,
      source: 'anyfusion-planner',
    } as never;
    const sessionId = 'planner_replay_applied';
    const turnId = 'turn_replay_applied';
    const submissionId = createPlannerProposalSubmissionId(sessionId, turnId, plan);
    const eventId = `plan_event_${submissionId}`;
    proposalRepo.ensureTurn(sessionId, turnId, 'recover');
    proposalRepo.reserveSubmission({
      sessionId,
      turnId,
      submissionId,
      planFingerprint: plannerProposalFingerprint(plan),
      planId: plan.id,
      eventId,
    });
    proposalRepo.markUncertain(sessionId, turnId, submissionId);
    const decision: KernelDecision = {
      schemaVersion: 5,
      configurationRevision: 'revision-test',
      id: 'decision_replay_applied',
      eventId,
      action: { type: 'deliver_direct_reply', response: 'already delivered' },
      reason: 'direct reply authorized',
    };
    const apply = vi.fn(async () => null);
    const replaySession = new ConversationSession({
      conversationId: 'conversation_replay_applied',
      plannerSessionId: sessionId,
      runtimePort: makePort('local-default', {
        planning: null,
        queries: {
          listKernelDecisionsBySession: () => [{
            decision,
            eventId,
            configurationRevision: 'revision-test',
          }] as never,
          findKernelApplicationByDecisionId: () => ({
            status: 'applied',
          }) as never,
        } as never,
        commands: {
          submitKernel: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
        } as never,
      }),
      mailbox: new ConversationInputMailbox({ execute: async () => undefined }),
      plannerProposalRepo: proposalRepo,
      planningContextBuilder: {
        build: ({ userInput }: { userInput: string }) => ({
          userInput,
          request: { sessionId, source: 'session' },
          pendingAuthorizationRequest: null,
          configuration: {
            revisionId: 'revision-test',
            contentHash: 'hash',
            models: [],
            routingCatalog: { configurationRevision: 'revision-test', agentClasses: [] },
          },
          timeoutMs: 1_000,
        }),
        getPlannerConfiguration: () => ({
          revisionId: 'revision-test',
          contentHash: 'hash',
          models: [],
          routingCatalog: { configurationRevision: 'revision-test', agentClasses: [] },
        }),
      } as never,
      sessionKernelRuntime: {
        forInput: () => ({ apply }),
      } as never,
      db,
    });
    const result = replaySession.submitPlannerProposal({
      sessionId,
      turnId,
      userInput: 'recover',
      submissionId,
      plan,
    });

    await expect(result).resolves.toMatchObject({
      status: 'accepted',
      outcome: 'direct_reply_delivered',
      displayText: 'already delivered',
    });
    expect(apply).not.toHaveBeenCalled();
    db.close();
  });
});

function replanConfiguration() {
  return {
    revisionId: 'revision-test',
    contentHash: 'hash',
    models: [{
      id: 'codex-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      region: 'international',
    }],
    routingCatalog: {
      version: 2,
      configurationRevision: 'revision-test',
      capabilities: [{ id: 'workspace-engineering', deliveryContract: 'Modify and verify workspace files.' }],
      agentClasses: [{
        id: 'codex-cli',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['workspace implementation'],
        avoidUseCases: [],
        affordances: ['workspace-read-write', 'workspace-command-validation'],
        modelPolicy: { mode: 'fixed', modelRef: 'codex-model' },
      }],
    },
  };
}

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
