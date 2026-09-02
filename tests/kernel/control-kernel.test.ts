import { describe, expect, it } from 'vitest';
import {
  ControlKernel,
  resolvePreferredModelRef,
  type KernelEvent,
  type KernelSnapshot,
} from '../../src/kernel/control-kernel.js';
import type {
  KernelConfigurationView,
  PlannerConfigurationView,
} from '../../src/configuration/index.js';
import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../../src/core/authorized-executor-binding.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import { capabilityRequestFingerprint, type NormalizedCapabilityRequest } from '../../src/resource/index.js';

const configurationRevision = 'revision-test';

const plannerConfiguration: PlannerConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:planner-test',
  models: [
    {
      id: 'codex-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      region: 'international',
    },
    {
      id: 'pi-model',
      capabilities: ['coding', 'tools'],
      reasoning: 'medium',
      region: 'international',
    },
  ],
  routingCatalog: {
    version: 2,
    configurationRevision,
    capabilities: [
      {
        id: 'current-web-research',
        deliveryContract: 'Research public web sources.',
      },
      {
        id: 'workspace-engineering',
        deliveryContract: 'Modify and verify workspace files.',
      },
    ],
    agentClasses: [
      {
        id: 'codex-cli',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['workspace implementation'],
        avoidUseCases: [],
        affordances: ['workspace-command-validation', 'workspace-read-write'],
        modelPolicy: { mode: 'fixed', modelRef: 'codex-model' },
      },
      {
        id: 'pi-agent',
        routingCapabilities: ['current-web-research', 'workspace-engineering'],
        primaryUseCases: ['research and implementation'],
        avoidUseCases: [],
        affordances: [
          'public-web-fetch',
          'public-web-search',
          'source-citation',
          'workspace-command-validation',
          'workspace-read-write',
        ],
        modelPolicy: { mode: 'fixed', modelRef: 'pi-model' },
      },
    ],
  },
};

const kernelConfiguration: KernelConfigurationView = {
  revisionId: configurationRevision,
  contentHash: 'sha256:kernel-test',
  agentClasses: {
    'codex-cli': {
      kind: 'executor',
      harnessRef: 'codex-harness',
      modelPolicy: { mode: 'fixed', modelRef: 'codex-model' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: true,
    },
    'pi-agent': {
      kind: 'executor',
      harnessRef: 'pi-harness',
      modelPolicy: { mode: 'fixed', modelRef: 'pi-model' },
      permissionProfileRef: 'workspace-default',
      routingCapabilities: ['current-web-research', 'workspace-engineering'],
      enabled: true,
      transport: 'local-cli',
      supportsProbe: true,
      supportsAbort: true,
      supportsContinuation: false,
    },
  },
  models: {
    'codex-model': {
      providerRef: 'openai',
      modelId: 'gpt-5.6-sol',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      enabled: true,
    },
    'pi-model': {
      providerRef: 'anthropic',
      modelId: 'pi-model-id',
      capabilities: ['coding', 'tools'],
      reasoning: 'medium',
      enabled: true,
    },
  },
  permissionProfiles: {
    'workspace-default': {
      profileId: 'workspace-engineering',
      version: 1,
      parameters: {},
    },
  },
  runtimePolicy: {
    maxConcurrentAttempts: 4,
  },
};

const codexBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-harness',
  providerRef: 'openai',
  modelRef: 'codex-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision,
};
const piBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-agent',
  harnessRef: 'pi-harness',
  providerRef: 'anthropic',
  modelRef: 'pi-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision,
};
const codexFingerprint = authorizedExecutorBindingFingerprint(codexBinding);
const piFingerprint = authorizedExecutorBindingFingerprint(piBinding);

const event: KernelEvent = {
  schemaVersion: 5,
  configurationRevision,
  type: 'plan_proposed',
  id: 'event_plan_1',
  correlationId: 'request_1',
  causationId: null,
  occurredAt: '2026-07-20T00:00:00.000Z',
  sessionId: 'session_1',
  requestText: 'hello',
  generationId: 'generation_event_plan_1',
  proposalSource: 'initial',
  targetGraphRevision: 1,
  proposal: {
    id: 'plan_1',
    schemaVersion: 8,
    action: 'direct_reply',
    confidence: 0.9,
    reason: 'answer directly',
    clarificationQuestion: null,
    response: { directReply: 'Hello' },
    task: {
      binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null,
      includeRecentConversationContext: false, priority: null,
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    authorizationResolution: null,
    workGraph: null,
    source: 'anyfusion-planner',
  },
};

const snapshot: KernelSnapshot = {
  schemaVersion: 5,
  type: 'plan_admission',
  tasks: [],
  runningTaskId: null,
  plannerConfiguration,
  kernelConfiguration,
  executorStatuses: [],
  v5WorkGraphTaskIds: [],
  eligibleContextRefKeys: [],
  pendingAuthorizationRequest: null,
};

describe('ControlKernel', () => {
  it('uses an Auto AgentClass default as the resolver preference for agent-class-default', () => {
    expect(resolvePreferredModelRef(
      { mode: 'agent-class-default' },
      {
        mode: 'auto',
        allowedModelRefs: ['cheap', 'preferred'],
        defaultModelRef: 'preferred',
      },
    )).toBe('preferred');
  });
  it('produces one deterministic action for a planning event', () => {
    const kernel = new ControlKernel();

    const first = kernel.decide(event, snapshot);
    const second = kernel.decide(event, snapshot);

    expect(first).toEqual(second);
    expect(first).toEqual({
      schemaVersion: 5,
      configurationRevision,
      id: 'decision_event_plan_1',
      eventId: 'event_plan_1',
      action: { type: 'deliver_direct_reply', response: 'Hello' },
      reason: 'direct reply authorized',
    });
  });

  it('authorizes a replan as the next revision of the same generation', () => {
    const proposal = workGraphPlan({
      goal: 'Finish remaining work',
      overrides: {
        task: {
          binding: 'reference', taskId: 'task_1', control: 'none', scope: null,
          title: 'Task', goal: 'Finish remaining work', includeRecentConversationContext: false,
          priority: { level: 'normal', reason: 'automatic replan' },
        },
      },
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const replanEvent: KernelEvent = {
      ...event,
      id: 'event_replan_1',
      taskId: 'task_1',
      proposal,
      generationId: 'generation_1',
      proposalSource: 'replan',
      targetGraphRevision: 2,
    };
    const replanSnapshot: KernelSnapshot = {
      ...snapshot,
      tasks: [{ id: 'task_1', status: 'running' }],
      runningTaskId: 'task_1',
      v5WorkGraphTaskIds: ['task_1'],
    };

    expect(new ControlKernel().decide(replanEvent, replanSnapshot).action).toMatchObject({
      type: 'authorize_task_plan', taskId: 'task_1', generationId: 'generation_1',
      graphRevision: 2, proposalSource: 'replan',
    });
  });

  it('admits executable Tasks from different Conversations independently', () => {
    const proposal = workGraphPlan({ goal: 'Run task B', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_conversation_b',
      conversationId: 'conversation-b',
      proposal,
      generationId: 'generation_conversation_b',
    }, {
      ...snapshot,
      activeTaskByConversation: { 'conversation-a': 'task-a' },
      occupiedConversationIds: ['conversation-a'],
      queuedTaskCountByConversation: { 'conversation-a': 0 },
    });

    expect(decision.action).toMatchObject({
      type: 'authorize_task_plan',
      scheduleState: 'eligible',
    });
  });

  it('authorizes a second initial Task from one Conversation as queued', () => {
    const proposal = workGraphPlan({ goal: 'Run task B', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_same_conversation_queued',
      conversationId: 'conversation-a',
      proposal,
      generationId: 'generation_same_conversation_queued',
    }, {
      ...snapshot,
      activeTaskByConversation: { 'conversation-a': 'task-a' },
      occupiedConversationIds: ['conversation-a'],
      queuedTaskCountByConversation: { 'conversation-a': 1 },
    });

    expect(decision.action).toMatchObject({
      type: 'authorize_task_plan',
      scheduleState: 'queued',
    });
  });

  it('rejects same-Conversation admission when the durable queue is full', () => {
    const proposal = workGraphPlan({ goal: 'Run task B', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_same_conversation_queue_full',
      conversationId: 'conversation-a',
      proposal,
      generationId: 'generation_same_conversation_queue_full',
    }, {
      ...snapshot,
      activeTaskByConversation: { 'conversation-a': 'task-a' },
      occupiedConversationIds: ['conversation-a'],
      queuedTaskCountByConversation: { 'conversation-a': 8 },
    });

    expect(decision.action).toEqual({ type: 'reject_request' });
    expect(decision.reason).toContain('queue limit reached');
  });

  it('resolves Codex Auto against GPT models from a different Provider', () => {
    const proposal = workGraphPlan({
      goal: 'Implement the requested change',
      capabilityClass: 'code_edit',
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    proposal.workGraph!.subtasks[0]!.executorBindings[0]!.modelSelection = {
      mode: 'agent-class-default',
    };

    const planner = structuredClone(plannerConfiguration);
    planner.models.push({
      id: 'codex-fast',
      providerRef: 'secondary',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      region: 'international',
    });
    const codexCatalog = planner.routingCatalog.agentClasses.find(
      agentClass => agentClass.id === 'codex-cli',
    )!;
    codexCatalog.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['codex-model', 'codex-fast'],
      defaultModelRef: 'codex-fast',
    };

    const kernel = structuredClone(kernelConfiguration);
    kernel.models['codex-model']!.costInputPerMillion = 10;
    kernel.models['codex-model']!.costOutputPerMillion = 10;
    kernel.models['codex-fast'] = {
      providerRef: 'secondary',
      modelId: 'gpt-5.6-fast',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      costInputPerMillion: 1,
      costOutputPerMillion: 1,
      enabled: true,
    };
    kernel.agentClasses['codex-cli']!.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['codex-model', 'codex-fast'],
      defaultModelRef: 'codex-fast',
    };

    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_cross_provider_auto',
      proposal,
      generationId: 'generation_cross_provider',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      plannerConfiguration: planner,
      kernelConfiguration: kernel,
    });

    expect(decision.action).toMatchObject({
      type: 'authorize_task_plan',
      authorizedBindingsBySubtask: {
        subtask_execute: [{
          providerRef: 'secondary',
          modelRef: 'codex-fast',
        }],
      },
      routing: {
        subtask_execute: [{
          binding: {
            providerRef: 'secondary',
            modelRef: 'codex-fast',
          },
        }],
      },
    });
  });

  it('requires and selects an image-capable model for image generation work', () => {
    const proposal = workGraphPlan({
      goal: '生成一张产品概念图',
      executor: 'pi-agent',
      deliveryKind: 'edit',
    });
    const subtask = proposal.workGraph!.subtasks[0]!;
    subtask.contextRefs = [];
    subtask.requiredCapabilities = ['image-generation'];
    subtask.executorBindings[0]!.modelSelection = {
      mode: 'agent-class-default',
    };

    const planner = structuredClone(plannerConfiguration);
    planner.routingCatalog.capabilities.push(
      {
        id: 'image-generation',
        deliveryContract: '使用明确支持图片生成的模型生成图片。',
      },
      {
        id: 'image-editing',
        deliveryContract: '使用明确支持图片编辑的模型修改图片。',
      },
    );
    const piCatalog = planner.routingCatalog.agentClasses.find(
      agentClass => agentClass.id === 'pi-agent',
    )!;
    piCatalog.routingCapabilities.push('image-generation', 'image-editing');
    piCatalog.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['pi-model', 'image-model'],
      defaultModelRef: 'pi-model',
    };
    planner.models.push({
      id: 'image-model',
      providerRef: 'openai',
      capabilities: ['image-generation', 'image-editing', 'vision'],
      reasoning: 'low',
      region: 'international',
    });

    const kernel = structuredClone(kernelConfiguration);
    kernel.agentClasses['pi-agent']!.routingCapabilities.push(
      'image-generation',
      'image-editing',
    );
    kernel.agentClasses['pi-agent']!.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['pi-model', 'image-model'],
      defaultModelRef: 'pi-model',
    };
    kernel.models['image-model'] = {
      providerRef: 'openai',
      modelId: 'gpt-image-2',
      capabilities: ['image-generation', 'image-editing', 'vision'],
      reasoning: 'low',
      enabled: true,
    };

    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_image_generation',
      proposal,
      generationId: 'generation_image_generation',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      plannerConfiguration: planner,
      kernelConfiguration: kernel,
    });

    expect(decision.action).toMatchObject({
      type: 'authorize_task_plan',
      authorizedBindingsBySubtask: {
        subtask_execute: [{
          agentClassRef: 'pi-agent',
          providerRef: 'openai',
          modelRef: 'image-model',
        }],
      },
      routing: {
        subtask_execute: [{
          binding: {
            providerRef: 'openai',
            modelRef: 'image-model',
          },
          rejectedCandidates: [{
            modelRef: 'pi-model',
            reason: 'missing_capability:image-generation',
          }],
        }],
      },
    });
  });

  it('does not require model tools capability for Pi current-web-research routing', () => {
    const proposal = workGraphPlan({
      goal: 'Research the latest public web information',
      executor: 'pi-agent',
      deliveryKind: 'report',
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];

    const deepseekConfiguration = structuredClone(kernelConfiguration);
    deepseekConfiguration.models['pi-model'] = {
      providerRef: 'deepseek',
      modelId: 'deepseek-v4-pro',
      capabilities: [],
      reasoning: 'high',
      enabled: true,
    };
    deepseekConfiguration.agentClasses['pi-agent']!.modelPolicy = {
      mode: 'fixed',
      modelRef: 'pi-model',
    };

    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_pi_current_web_research',
      proposal,
      generationId: 'generation_pi_current_web_research',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      kernelConfiguration: deepseekConfiguration,
    });

    expect(decision.action).toMatchObject({
      type: 'authorize_task_plan',
      authorizedBindingsBySubtask: {
        subtask_execute: [{
          agentClassRef: 'pi-agent',
          providerRef: 'deepseek',
          modelRef: 'pi-model',
        }],
      },
    });
    expect(decision.reason).toBe('work graph authorized');
  });

  it('does not reject a workspace model merely because its capability profile is empty', () => {
    const proposal = workGraphPlan({
      goal: 'Implement the requested workspace change',
      executor: 'codex-cli',
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];

    const configuration = structuredClone(kernelConfiguration);
    configuration.models['codex-model'] = {
      ...configuration.models['codex-model']!,
      capabilities: [],
    };

    const decision = new ControlKernel().decide({
      ...event,
      id: 'event_empty_model_profile',
      proposal,
      generationId: 'generation_empty_model_profile',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      kernelConfiguration: configuration,
    });

    expect(decision.action).toMatchObject({
      type: 'authorize_task_plan',
      authorizedBindingsBySubtask: {
        subtask_execute: [{
          agentClassRef: 'codex-cli',
          modelRef: 'codex-model',
        }],
      },
    });
  });

  it('rejects an empty non-null task reference instead of authorizing it as a new Task', () => {
    const proposal = workGraphPlan({ goal: 'Create an artifact' });
    proposal.task.taskId = '';

    expect(new ControlKernel().decide({ ...event, proposal }, {
      ...snapshot,
      eligibleContextRefKeys: ['current_user_input'],
    })).toMatchObject({
      action: { type: 'reject_request' },
      reason: 'task not found: ',
    });
  });

  it('defers an exhausted replan and activates it only after the current frontier is available', () => {
    const proposal = workGraphPlan({
      goal: 'Finish remaining work',
      overrides: {
        task: {
          binding: 'reference', taskId: 'task_1', control: 'none', scope: null,
          title: 'Task', goal: 'Finish remaining work', includeRecentConversationContext: false,
          priority: { level: 'normal', reason: 'automatic replan' },
        },
      },
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const replanEvent: Extract<KernelEvent, { type: 'plan_proposed' }> = {
      ...event,
      id: 'event_replan_waiting',
      correlationId: 'replan_request_1',
      taskId: 'task_1',
      proposal,
      generationId: 'generation_1',
      proposalSource: 'replan',
      targetGraphRevision: 2,
      availabilityExplanation: 'The configured Executors are currently unavailable.',
    };
    const errorStatuses = proposal.workGraph!.subtasks[0]!.executorBindings.map(binding => ({
      agentClassName: binding.agentClassRef,
      classHealth: 'error' as const,
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: event.occurredAt,
    }));
    const admission: Extract<KernelSnapshot, { type: 'plan_admission' }> = {
      ...snapshot,
      tasks: [{ id: 'task_1', status: 'running' }],
      runningTaskId: 'task_1',
      executorStatuses: errorStatuses,
      v5WorkGraphTaskIds: ['task_1'],
    };
    expect(new ControlKernel().decide(replanEvent, admission).action).toMatchObject({
      type: 'defer_task_plan_for_availability',
      taskId: 'task_1',
      explanation: 'The configured Executors are currently unavailable.',
    });

    const recoveredName = proposal.workGraph!.subtasks[0]!.executorBindings[0]!.agentClassRef;
    const recoveryEvent: Extract<KernelEvent, { type: 'executor_recovered' }> = {
      schemaVersion: 5,
      configurationRevision,
      type: 'executor_recovered',
      id: 'executor_recovered_1',
      correlationId: 'replan_request_1',
      causationId: 'recovery_check_1',
      occurredAt: '2026-07-30T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      agentClassName: recoveredName,
      recoveryCheckId: 'recovery_check_1',
    };
    const recoverySnapshot: Extract<KernelSnapshot, { type: 'availability_recovery' }> = {
      schemaVersion: 5,
      type: 'availability_recovery',
      task: { id: 'task_1', status: 'blocked' },
      activeGenerationId: 'generation_1',
      activeGraphRevision: 1,
      deferredPlan: replanEvent,
      deferredBindings: [codexBinding],
      executorStatuses: errorStatuses.map(status => status.agentClassName === recoveredName
        ? { ...status, classHealth: 'healthy' as const }
        : status),
    };
    expect(new ControlKernel().decide(recoveryEvent, recoverySnapshot).action).toMatchObject({
      type: 'activate_deferred_task_plan',
      taskId: 'task_1',
      replanRequestId: 'replan_request_1',
      generationId: 'generation_1',
      graphRevision: 2,
    });
  });

  it('selects one ready Subtask and the first authorized AgentClass in a batch', () => {
    const decision = new ControlKernel().decide(runtimeEvent({ type: 'dispatch_requested', reason: 'start' }), dispatchSnapshot());
    expect(decision.action).toMatchObject({
      type: 'dispatch_batch',
      taskId: 'task_1',
      items: [expect.objectContaining({
        subtaskId: 'subtask_1',
        authorizedBinding: codexBinding,
        bindingFingerprint: codexFingerprint,
        attemptKind: 'primary',
      })],
    });
  });

  it('authorizes at most four stable independent items and filters active or conflicting Subtasks', () => {
    const batch = dispatchSnapshot();
    batch.subtasks = ['e', 'c', 'a', 'd', 'b', 'f'].map(id => ({
      id, taskId: 'task_1', status: 'ready' as const,
      executorBindings: [codexBinding],
    }));
    batch.frontier = ['a', 'b', 'c', 'd', 'e', 'f'];
    batch.dispatchItems = [{
      attemptId: 'attempt_b',
      subtaskId: 'b',
      bindingFingerprint: codexFingerprint,
      status: 'running',
      order: 0,
    }];
    batch.resourceConflictSubtaskIds = ['c'];
    batch.availableSlots = 4;

    const first = new ControlKernel().decide(
      runtimeEvent({ type: 'dispatch_requested', reason: 'start independent work' }),
      batch,
    );
    const second = new ControlKernel().decide(
      runtimeEvent({ type: 'dispatch_requested', reason: 'start independent work' }),
      batch,
    );

    expect(first).toEqual(second);
    expect(first.action).toMatchObject({
      type: 'dispatch_batch',
      items: [
        { subtaskId: 'a', order: 1 },
        { subtaskId: 'd', order: 2 },
        { subtaskId: 'e', order: 3 },
        { subtaskId: 'f', order: 4 },
      ],
    });
  });

  it('authorizes one atomic downstream cancellation closure and rejects a closure containing done work', () => {
    const controlSnapshot: Extract<KernelSnapshot, { type: 'task_control' }> = {
      schemaVersion: 5,
      type: 'task_control',
      task: { id: 'task_1', status: 'running' },
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtasks: [
        cancellationSubtask('root', 'done'),
        cancellationSubtask('left', 'running', ['root']),
        cancellationSubtask('right', 'ready', ['root']),
        cancellationSubtask('join', 'awaiting_decision', ['left', 'right']),
      ],
      completionBlockedReasons: [],
      partialCancellation: false,
    };
    const cancelEvent: KernelEvent = {
      ...runtimeEvent({
        type: 'subtasks_cancel_requested',
        targetSubtaskIds: ['left'],
        reason: 'user command',
      }),
      subtaskId: undefined,
    };

    expect(new ControlKernel().decide(cancelEvent, controlSnapshot).action).toEqual({
      type: 'cancel_subtasks',
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtaskIds: ['join', 'left'],
      expectedStatuses: [
        { subtaskId: 'join', status: 'awaiting_decision' },
        { subtaskId: 'left', status: 'running' },
      ],
    });

    const rejected = new ControlKernel().decide({
      ...cancelEvent,
      id: 'event_cancel_done',
      targetSubtaskIds: ['root'],
    }, controlSnapshot);
    expect(rejected.action).toEqual({ type: 'reject_request' });
    expect(rejected.reason).toContain('already_done');
  });

  it('treats every outcome after a Task or Subtask cancellation fence as a no-op', () => {
    const failed = executionFailure('attempt_cancelled', codexBinding, 'primary', 'network');
    const cancelledTask = dispatchSnapshot();
    cancelledTask.task = { id: 'task_1', status: 'cancelled' };
    expect(new ControlKernel().decide(failed, cancelledTask).action).toEqual({ type: 'no_op' });

    const cancelledSubtask = dispatchSnapshot();
    cancelledSubtask.subtasks[0]!.status = 'cancelled';
    cancelledSubtask.frontier = [];
    expect(new ControlKernel().decide(failed, cancelledSubtask).action).toEqual({ type: 'no_op' });
  });

  it('accepts partial results only after cancellation has quiesced with at least one completed node', () => {
    const partialSnapshot: Extract<KernelSnapshot, { type: 'task_control' }> = {
      schemaVersion: 5,
      type: 'task_control',
      task: { id: 'task_1', status: 'blocked' },
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtasks: [
        cancellationSubtask('published', 'done'),
        cancellationSubtask('cancelled', 'cancelled'),
      ],
      completionBlockedReasons: [],
      partialCancellation: true,
    };
    const partialEvent = runtimeEvent({
      type: 'partial_result_acceptance_requested',
    });
    expect(new ControlKernel().decide(partialEvent, partialSnapshot).action).toEqual({
      type: 'accept_partial_result',
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      completedSubtaskIds: ['published'],
      cancelledSubtaskIds: ['cancelled'],
    });
  });

  it('tries remaining AgentClasses in order, then waits for capacity', () => {
    const kernel = new ControlKernel();
    const failed = runtimeEvent({
      type: 'capacity_signal',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      available: false,
      cycleId: 'cycle_1',
      attemptKind: 'primary', attemptPayload: null,
    });
    expect(kernel.decide(failed, dispatchSnapshot()).action).toEqual({
      type: 'probe_capacity',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      authorizedBinding: piBinding,
      bindingFingerprint: piFingerprint,
    });
    expect(kernel.decide(failed, dispatchSnapshot([piFingerprint])).action).toEqual({
      type: 'wait_for_capacity', taskId: 'task_1', subtaskId: 'subtask_1',
    });
  });

  it('authorizes explicit recovery resolution but refuses unsafe effect retry', () => {
    const kernel = new ControlKernel();
    const recoveryEvent: KernelEvent = {
      schemaVersion: 5, configurationRevision, type: 'recovery_resolution_requested', id: 'recovery_event_1',
      correlationId: 'task_1', causationId: null, occurredAt: '2026-07-21T00:00:00.000Z',
      sessionId: 'session_1', taskId: 'task_1', recoveryItemId: 'effect_1', resolution: 'retry',
    };
    const unsafe: KernelSnapshot = {
      schemaVersion: 5, type: 'recovery', task: { id: 'task_1', status: 'blocked' },
      item: { id: 'effect_1', kind: 'effect', status: 'uncertain', retrySafe: false },
    };
    expect(kernel.decide(recoveryEvent, unsafe).action).toEqual({
      type: 'block_work', taskId: 'task_1', subtaskId: null,
    });
    expect(kernel.decide({ ...recoveryEvent, resolution: 'assume_applied' }, unsafe).action).toEqual({
      type: 'resolve_recovery', taskId: 'task_1', recoveryItemId: 'effect_1', resolution: 'assume_applied',
    });
    expect(kernel.decide(recoveryEvent, {
      ...unsafe,
      item: { id: 'effect_1', kind: 'application', status: 'uncertain', retrySafe: true },
    }).action).toEqual({
      type: 'resolve_recovery', taskId: 'task_1', recoveryItemId: 'effect_1', resolution: 'retry',
    });
  });

  it('skips a class during derived cooldown and makes it eligible as the next serial probe after cooldown', () => {
    const failures = [0, 1, 2].map(index => ({
      completedAt: `2026-07-20T00:0${2 - index}:00.000Z`,
      outcome: 'failed' as const,
      failure: { kind: 'network' as const, scope: 'agent_class' as const, code: 'network_failed', summary: 'network failed' },
    }));
    const cooling = dispatchSnapshot();
    cooling.executorStatuses = [{
      agentClassName: 'codex-cli', classHealth: 'healthy', recentAttempts: failures,
      updatedAt: '2026-07-20T00:02:00.000Z',
    }];

    expect(new ControlKernel().decide(runtimeEvent({
      type: 'dispatch_requested', reason: 'cooldown dispatch', occurredAt: '2026-07-20T00:03:00.000Z',
    }), cooling).action).toMatchObject({
      type: 'dispatch_batch',
      items: [expect.objectContaining({
        authorizedBinding: piBinding,
        bindingFingerprint: piFingerprint,
      })],
    });
    expect(new ControlKernel().decide(runtimeEvent({
      type: 'dispatch_requested', reason: 'probe dispatch', occurredAt: '2026-07-20T00:07:00.000Z',
    }), cooling).action).toMatchObject({
      type: 'dispatch_batch',
      items: [expect.objectContaining({
        authorizedBinding: codexBinding,
        bindingFingerprint: codexFingerprint,
      })],
    });
  });

  it('blocks failures, continues successes, and completes an exhausted graph', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(runtimeEvent({
      type: 'execution_outcome',
      terminalKind: 'failed',
      attemptId: 'attempt_1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      attemptKind: 'primary', sourceAttemptId: null,
      failure: { kind: 'unknown', scope: 'attempt', code: 'executor_failed', summary: 'executor failed' },
    }), dispatchSnapshot([], 'awaiting_decision')).action).toEqual({
      type: 'block_work', taskId: 'task_1', subtaskId: 'subtask_1',
    });
    expect(kernel.decide(runtimeEvent({
      type: 'execution_outcome',
      terminalKind: 'completed',
      attemptId: 'attempt_1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      attemptKind: 'primary', sourceAttemptId: null, failure: null,
    }), dispatchSnapshot([], 'done')).action).toEqual({ type: 'complete_task', taskId: 'task_1' });
  });

  it('waits for dependency publication instead of converting an empty frontier into an ordinary block', () => {
    const snapshot = dispatchSnapshot();
    snapshot.frontier = [];
    snapshot.subtasks = [
      {
        id: 'upstream',
        taskId: 'task_1',
        status: 'awaiting_integration',
        executorBindings: [codexBinding],
      },
      {
        id: 'downstream',
        taskId: 'task_1',
        status: 'ready',
        executorBindings: [codexBinding],
      },
    ];
    snapshot.dependencyReadiness = [{
      sourceSubtaskId: 'upstream',
      targetSubtaskId: 'downstream',
      code: 'pending_publication',
      terminal: false,
      detail: 'upstream publication has not been integrated',
    }];

    const result = new ControlKernel().decide(
      runtimeEvent({
        type: 'dispatch_requested',
        subtaskId: undefined,
        reason: 'continue after upstream attempt',
      }),
      snapshot,
    );

    expect(result.action).toEqual({ type: 'no_op' });
    expect(result.reason).toContain('dependency publication');
  });

  it('authorizes explicit resume only for a recoverable blocked Task and restores runnable Subtasks through Runtime', () => {
    const snapshot = dispatchSnapshot();
    snapshot.task = { id: 'task_1', status: 'blocked' };
    snapshot.subtasks[0]!.status = 'ready';
    const result = new ControlKernel().decide({
      schemaVersion: 5,
      configurationRevision,
      type: 'task_resume_requested',
      id: 'resume_event_1',
      correlationId: 'resume_request_1',
      causationId: null,
      occurredAt: '2026-07-20T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      blockerCategory: 'capacity',
      sourceInputExcerpt: 'continue',
      newlyProvidedResources: [],
      idempotencyKey: 'resume:task_1:continue',
    }, snapshot);

    expect(result.action).toEqual({
      type: 'resume_task',
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtaskIds: ['subtask_1'],
      blockerCategory: 'capacity',
    });
  });

  it('does not clear a manual or contract blocker on explicit resume', () => {
    const snapshot = dispatchSnapshot();
    snapshot.task = { id: 'task_1', status: 'blocked' };
    const result = new ControlKernel().decide({
      schemaVersion: 5,
      configurationRevision,
      type: 'task_resume_requested',
      id: 'resume_event_manual',
      correlationId: 'resume_request_manual',
      causationId: null,
      occurredAt: '2026-07-20T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      blockerCategory: 'contract',
      sourceInputExcerpt: 'continue',
      newlyProvidedResources: [],
      idempotencyKey: 'resume:task_1:contract',
    }, snapshot);

    expect(result.action).toEqual({
      type: 'block_work',
      taskId: 'task_1',
      subtaskId: null,
    });
  });

  it('keeps an unknown blocker fail-closed even for read-only work', () => {
    const snapshot = dispatchSnapshot();
    snapshot.task = { id: 'task_1', status: 'blocked' };
    snapshot.subtasks[0]!.status = 'blocked';
    snapshot.recoverySafety = 'read_only';
    const result = new ControlKernel().decide({
      schemaVersion: 5,
      configurationRevision,
      type: 'task_resume_requested',
      id: 'resume_event_read_only_unknown',
      correlationId: 'resume_request_read_only_unknown',
      causationId: null,
      occurredAt: '2026-07-20T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      blockerCategory: 'unknown',
      sourceInputExcerpt: 'continue',
      newlyProvidedResources: [],
      idempotencyKey: 'resume:task_1:read-only-unknown',
    }, snapshot);

    expect(result.action).toEqual({
      type: 'block_work',
      taskId: 'task_1',
      subtaskId: null,
    });
  });

  it('authorizes exact workspace continuation when a safe result only lacks the completion marker', () => {
    const snapshot = dispatchSnapshot([], 'awaiting_decision');
    snapshot.task = { id: 'task_1', status: 'running' };
    snapshot.resumeRecoveryCandidates = [{
      subtaskId: 'subtask_1',
      sourceAttemptId: 'attempt_uncertified',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      recoveryMode: 'native_session',
      reason: 'completion_marker_missing',
    }];

    const result = new ControlKernel().decide({
      schemaVersion: 5,
      configurationRevision,
      type: 'task_resume_requested',
      id: 'resume_event_uncertified',
      correlationId: 'resume_request_uncertified',
      causationId: null,
      occurredAt: '2026-07-20T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      blockerCategory: 'unknown',
      sourceInputExcerpt: 'continue',
      newlyProvidedResources: [],
      idempotencyKey: 'resume:task_1:uncertified',
    }, snapshot);

    expect(result.action).toEqual({
      type: 'resume_task',
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      graphRevision: 1,
      subtaskIds: [],
      blockerCategory: 'unknown',
      recovery: {
        subtaskId: 'subtask_1',
        sourceAttemptId: 'attempt_uncertified',
        authorizedBinding: codexBinding,
        bindingFingerprint: codexFingerprint,
        attemptKind: 'continuation',
        recoveryMode: 'native_session',
        defaultResourceGrant: [],
      },
    });
  });

  it('authorizes metadata-only repair for a legacy blocked uncertified result', () => {
    const snapshot = dispatchSnapshot([], 'blocked');
    snapshot.task = { id: 'task_1', status: 'blocked' };
    snapshot.resumeRecoveryCandidates = [{
      subtaskId: 'subtask_1',
      sourceAttemptId: 'attempt_uncertified',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      recoveryMode: 'recovery_packet',
      reason: 'completion_metadata_invalid',
    } as never];

    const result = new ControlKernel().decide({
      schemaVersion: 5,
      configurationRevision,
      type: 'task_resume_requested',
      id: 'resume_event_metadata_repair',
      correlationId: 'resume_request_metadata_repair',
      causationId: null,
      occurredAt: '2026-07-20T00:00:00.000Z',
      sessionId: 'session_1',
      taskId: 'task_1',
      blockerCategory: 'unknown',
      sourceInputExcerpt: 'continue',
      newlyProvidedResources: [],
      idempotencyKey: 'resume:task_1:metadata-repair',
    }, snapshot);

    expect(result.action).toMatchObject({
      type: 'resume_task',
      taskId: 'task_1',
      recovery: {
        subtaskId: 'subtask_1',
        sourceAttemptId: 'attempt_uncertified',
        attemptKind: 'contract_correction',
      },
    });
  });

  it('waits once for preferred infrastructure recovery, then falls back exactly once per remaining class', () => {
    const kernel = new ControlKernel();
    const firstFailure = executionFailure('attempt_1', codexBinding, 'primary', 'network');
    const firstSnapshot = dispatchSnapshot([], 'awaiting_decision');
    firstSnapshot.attempts = [attemptFact(firstFailure)];

    expect(kernel.decide(firstFailure, firstSnapshot).action).toEqual({
      type: 'wait_for_retry',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      resumeAt: '2026-07-20T00:00:05.000Z',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      sourceAttemptId: 'attempt_1',
    });

    const continuedFailure = executionFailure(
      'attempt_2',
      codexBinding,
      'continuation',
      'network',
      'attempt_1',
    );
    const continuedSnapshot = dispatchSnapshot([], 'awaiting_decision');
    continuedSnapshot.attempts = [attemptFact(continuedFailure), attemptFact(firstFailure)];
    expect(kernel.decide(continuedFailure, continuedSnapshot).action).toMatchObject({
      type: 'dispatch_batch',
      items: [expect.objectContaining({
        authorizedBinding: piBinding,
        bindingFingerprint: piFingerprint,
        attemptKind: 'fallback',
        sourceAttemptId: 'attempt_2',
        recoveryMode: 'recovery_packet',
      })],
    });
  });

  it('waits for retry after a preferred Executor timeout instead of blocking work', () => {
    const kernel = new ControlKernel();
    const timeout = executionFailure('attempt_timeout', codexBinding, 'primary', 'timeout');
    const snapshot = dispatchSnapshot([], 'awaiting_decision');
    snapshot.attempts = [attemptFact(timeout)];

    expect(kernel.decide(timeout, snapshot).action).toEqual({
      type: 'wait_for_retry',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      resumeAt: '2026-07-20T00:00:30.000Z',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      sourceAttemptId: 'attempt_timeout',
    });
  });

  it('falls back immediately for task failure and requests only one automatic replan per generation', () => {
    const kernel = new ControlKernel();
    const taskFailure = executionFailure('attempt_1', codexBinding, 'primary', 'task_failed');
    const fallbackSnapshot = dispatchSnapshot([], 'awaiting_decision');
    fallbackSnapshot.attempts = [attemptFact(taskFailure)];
    expect(kernel.decide(taskFailure, fallbackSnapshot).action).toMatchObject({
      type: 'dispatch_batch',
      items: [expect.objectContaining({
        authorizedBinding: piBinding,
        bindingFingerprint: piFingerprint,
        attemptKind: 'fallback',
      })],
    });

    const fallbackFailure = executionFailure(
      'attempt_2',
      piBinding,
      'fallback',
      'task_failed',
      'attempt_1',
    );
    const exhausted = dispatchSnapshot([], 'awaiting_decision');
    exhausted.attempts = [attemptFact(fallbackFailure), attemptFact(taskFailure)];
    expect(kernel.decide(fallbackFailure, exhausted).action).toEqual({
      type: 'queue_generation_replan',
      taskId: 'task_1',
      generationId: 'generation_task_1_1',
      sourceRevision: 1,
      requestId: 'generation_replan_task_1_generation_task_1_1_1',
    });
    exhausted.automaticReplansUsed = 1;
    expect(kernel.decide(fallbackFailure, exhausted).action).toEqual({ type: 'park_for_replan', taskId: 'task_1' });
  });

  it('authorizes one metadata correction and then blocks when correction is exhausted', () => {
    const kernel = new ControlKernel();
    const first = runtimeEvent({
      type: 'execution_result_observed',
      attemptId: 'attempt_1',
      workUnitId: 'wu_1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      contract: { schemaVersion: 2 }, violations: [{ code: 'missing', path: '$.handoffs', message: 'required' }],
      receiptCount: 1, responseBytes: 100,
      resultId: 'result_attempt_1_safe',
      deliverability: 'deliverable',
      certification: 'uncertified',
      safety: 'safe',
    });
    expect(kernel.decide(first, dispatchSnapshot([], 'awaiting_decision')).action).toMatchObject({
      type: 'dispatch_batch',
      items: [expect.objectContaining({
        authorizedBinding: codexBinding,
        bindingFingerprint: codexFingerprint,
        attemptKind: 'contract_correction',
      })],
    });
    expect(kernel.decide({ ...first, id: 'contract_2', receiptCount: 2 }, dispatchSnapshot([], 'awaiting_decision')).action).toEqual({
      type: 'block_work',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      preserveSubtaskState: true,
    });
  });

  it('blocks a safe result when its AgentClass does not support response-only correction', () => {
    const event = runtimeEvent({
      type: 'execution_result_observed',
      attemptId: 'attempt_pi',
      workUnitId: 'wu_pi',
      authorizedBinding: piBinding,
      bindingFingerprint: piFingerprint,
      contract: { schemaVersion: 2 },
      violations: [{ code: 'missing', path: '$.handoffs', message: 'required' }],
      receiptCount: 1,
      responseBytes: 100,
      resultId: 'result_pi_safe',
      deliverability: 'deliverable',
      certification: 'uncertified',
      safety: 'safe',
    });

    expect(new ControlKernel().decide(
      event,
      dispatchSnapshot([], 'awaiting_decision'),
    ).action).toEqual({
      type: 'block_work',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      preserveSubtaskState: true,
    });
  });

  it('blocks only a quarantined result with a real safety violation', () => {
    const event = runtimeEvent({
      type: 'execution_result_observed',
      attemptId: 'attempt_unsafe',
      workUnitId: 'wu_1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      contract: { schemaVersion: 4 },
      violations: [{
        code: 'completion_report_workspace_changed',
        path: 'workspaceDelta',
        message: 'report changed the workspace',
      }],
      receiptCount: 1,
      responseBytes: 100,
      resultId: null,
      deliverability: 'quarantined',
      certification: 'uncertified',
      safety: 'safety_blocked',
    });

    expect(new ControlKernel().decide(
      event,
      dispatchSnapshot([], 'awaiting_decision'),
    ).action).toEqual({
      type: 'block_work',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
    });
  });

  it('blocks when a metadata correction attempt fails', () => {
    const event = runtimeEvent({
      type: 'execution_outcome',
      attemptId: 'attempt_correction',
      terminalKind: 'failed',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      attemptKind: 'contract_correction',
      sourceAttemptId: 'attempt_primary',
      failure: {
        kind: 'adapter',
        scope: 'attempt',
        code: 'correction_unavailable',
        summary: 'metadata correction failed',
      },
    });

    expect(new ControlKernel().decide(
      event,
      dispatchSnapshot([], 'awaiting_decision'),
    ).action).toEqual({
      type: 'block_work',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      preserveSubtaskState: true,
    });
  });

  it('lets the merge conflict observation own repair failure policy', () => {
    const event = runtimeEvent({
      type: 'execution_outcome',
      attemptId: 'attempt_merge_repair',
      terminalKind: 'failed',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      attemptKind: 'merge_repair',
      sourceAttemptId: 'attempt_primary',
      failure: {
        kind: 'unknown',
        scope: 'attempt',
        code: 'attempt_exception',
        summary: 'merge repair trailer protocol is invalid',
      },
    });

    expect(new ControlKernel().decide(
      event,
      dispatchSnapshot([], 'awaiting_decision'),
    )).toMatchObject({
      action: { type: 'no_op' },
      reason: 'merge repair failure is governed by the publication conflict chain',
    });
  });

  it('keeps merge repair on the original AgentClass for three attempts, then requests one conflict replan', () => {
    const kernel = new ControlKernel();
    const conflict = runtimeEvent({
      type: 'merge_conflict_observed',
      publicationId: 'publication_1',
      conflictChainId: 'conflict_chain_1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      sourceAttemptId: 'attempt_primary',
      repairAttemptsUsed: 0,
      conflictReplansUsed: 0,
      conflictingPaths: ['src/shared.ts'],
    });

    expect(kernel.decide(conflict, dispatchSnapshot([], 'awaiting_decision')).action).toMatchObject({
      type: 'dispatch_batch',
      items: [expect.objectContaining({
        subtaskId: 'subtask_1',
        authorizedBinding: codexBinding,
        bindingFingerprint: codexFingerprint,
        attemptKind: 'merge_repair',
        sourceAttemptId: 'attempt_primary',
      })],
    });
    expect(kernel.decide({
      ...conflict, id: 'conflict_after_three_repairs', repairAttemptsUsed: 3,
    }, dispatchSnapshot([], 'awaiting_decision')).action).toEqual({
      type: 'request_merge_replan',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      publicationId: 'publication_1',
      conflictChainId: 'conflict_chain_1',
    });
    expect(kernel.decide({
      ...conflict,
      id: 'conflict_after_replan',
      repairAttemptsUsed: 3,
      conflictReplansUsed: 1,
    }, dispatchSnapshot([], 'awaiting_decision')).action).toEqual({
      type: 'park_for_replan',
      taskId: 'task_1',
    });
  });

  it('only probes a capacity block after the configured timer interval', () => {
    const kernel = new ControlKernel();
    const timer = runtimeEvent({
      type: 'timer_tick', occurredAt: '2026-07-20T00:01:00.000Z', wakeKind: 'capacity',
      sourceDecisionId: 'decision_capacity', scheduledFor: '2026-07-20T00:01:00.000Z', retry: null,
    });
    const timerSnapshot: KernelSnapshot = {
      schemaVersion: 5, type: 'timer', capacityBlockedAt: '2026-07-20T00:00:00.000Z', recheckAfterMs: 60_000,
      task: { id: 'task_1', status: 'blocked' }, wakeAuthorized: true,
      capacityBindings: [codexBinding], executorStatuses: [],
      nativeContinuationAgentClasses: ['codex-cli'],
      defaultResourceGrant: [],
    };
    expect(kernel.decide(timer, timerSnapshot).action).toEqual({
      type: 'probe_capacity',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
    });
    expect(kernel.decide({ ...timer, id: 'timer_early', occurredAt: '2026-07-20T00:00:59.999Z' }, timerSnapshot).action).toEqual({ type: 'no_op' });
    expect(kernel.decide({ ...timer, id: 'timer_cancelled' }, {
      ...timerSnapshot,
      task: { id: 'task_1', status: 'cancelled' },
      wakeAuthorized: false,
    }).action).toEqual({ type: 'no_op' });
  });

  it('allows dispatch when another Conversation owns the active slot', () => {
    const kernel = new ControlKernel();
    const result = kernel.decide(runtimeEvent({
      type: 'dispatch_requested',
      reason: 'start',
      conversationId: 'conversation-b',
    }), {
      ...dispatchSnapshot(),
      task: { id: 'task_1', status: 'running', conversationId: 'conversation-b' },
      runningTaskId: 'task_other',
      activeTaskByConversation: { 'conversation-a': 'task_other' },
    });
    expect(result.action.type).toBe('dispatch_batch');
  });

  it('blocks dispatch when the same Conversation slot owns another Task', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(runtimeEvent({
      type: 'dispatch_requested',
      reason: 'start',
      conversationId: 'conversation-a',
    }), {
      ...dispatchSnapshot(),
      task: { id: 'task_1', status: 'running', conversationId: 'conversation-a' },
      runningTaskId: null,
      activeTaskByConversation: { 'conversation-a': 'task_other' },
    }).action).toEqual({ type: 'block_work', taskId: 'task_1', subtaskId: 'subtask_1' });
  });

  it('keeps the legacy single-active fence when owner facts are unavailable', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(runtimeEvent({ type: 'dispatch_requested', reason: 'start' }), {
      ...dispatchSnapshot(), runningTaskId: 'task_other',
    }).action).toEqual({ type: 'block_work', taskId: 'task_1', subtaskId: 'subtask_1' });
    expect(kernel.decide(runtimeEvent({ type: 'dispatch_requested', reason: 'start' }), {
      schemaVersion: 5, type: 'invalid', reason: 'corrupt snapshot',
    }).action.type).toBe('block_work');
  });

  it('decides grant, deny, and Planner escalation from explicit permission facts', () => {
    const kernel = new ControlKernel();
    const request = permissionRequest();
    const permissionEvent = runtimeEvent({ type: 'permission_requested', attemptId: request.attemptId, request });
    const base: Extract<KernelSnapshot, { type: 'permission' }> = {
      schemaVersion: 5, type: 'permission', request, requestStatus: 'pending', currentGrants: [],
      rules: [], userAuthorizationFingerprints: [], previouslyDeniedFingerprints: [], attemptActive: true,
      workspaceId: 'workspace-1', checkpointId: 'checkpoint-1',
    };
    expect(kernel.decide(permissionEvent, {
      ...base,
      rules: [{ id: 'allow-example', effect: 'allow', capability: 'network_target', operation: 'GET', partition: request.partition, reason: 'approved public endpoint' }],
    }).action).toMatchObject({ type: 'grant_capability', requestId: request.id, ruleId: 'allow-example' });
    expect(kernel.decide({
      ...permissionEvent, id: 'hard-deny', request: { ...request, operation: 'bypass_egress_proxy' },
    }, { ...base, request: { ...request, operation: 'bypass_egress_proxy' } }).action).toMatchObject({
      type: 'deny_capability', notifyPlanner: false,
    });
    const secret = permissionRequest({ capability: 'sealed_secret', operation: 'use', resource: 'secret:deploy' });
    expect(kernel.decide(
      { ...permissionEvent, id: 'secret-event', request: secret },
      { ...base, request: secret },
    ).action).toMatchObject({ type: 'escalate_capability', notifyPlanner: true });
  });

  it('records exact approval as recovery when the old attempt is gone', () => {
    const request = permissionRequest({ capability: 'repository_promotion', operation: 'push' });
    const resolution = runtimeEvent({
      type: 'permission_resolution_received', attemptId: request.attemptId, requestId: request.id,
      resolution: 'approve', source: 'command', plannerPlanId: null,
    });
    const decision = new ControlKernel().decide(resolution, {
      schemaVersion: 5, type: 'permission', request, requestStatus: 'pending', rules: [], currentGrants: [],
      userAuthorizationFingerprints: [], previouslyDeniedFingerprints: [], attemptActive: false,
      workspaceId: 'workspace-1', checkpointId: 'checkpoint-1',
    });
    expect(decision.action).toMatchObject({
      type: 'recover_workspace_attempt', requestId: request.id, workspaceId: 'workspace-1',
      authorization: { resolution: 'approve', source: 'command' },
    });
  });

  it('turns partition conflicts into waits and sandbox loss into workspace recovery', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(runtimeEvent({
      type: 'partition_conflict_observed', attemptId: 'attempt-1', claims: [], conflictingLeaseIds: ['lease-1'],
    }), {
      schemaVersion: 5, type: 'partition', conflictConfirmed: true, workspaceId: 'workspace-1', checkpointId: null,
    }).action).toEqual({
      type: 'wait_for_partition', taskId: 'task_1', subtaskId: 'subtask_1', conflictingLeaseIds: ['lease-1'],
    });
    expect(kernel.decide(runtimeEvent({
      type: 'sandbox_lost', attemptId: 'attempt-1', containerId: null,
      workspaceId: 'workspace-1', checkpointId: 'checkpoint-1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      attemptKind: 'fallback',
      sourceAttemptId: 'attempt-primary',
      recoveryMode: 'recovery_packet',
    }), {
      schemaVersion: 5, type: 'sandbox_recovery', workspaceExists: true,
      workspaceId: 'workspace-1', checkpointId: 'checkpoint-1', activeLeaseIds: [],
    }).action).toMatchObject({
      type: 'recover_workspace_attempt',
      workspaceId: 'workspace-1',
      lostAttemptId: 'attempt-1',
      authorizedBinding: codexBinding,
      bindingFingerprint: codexFingerprint,
      attemptKind: 'fallback',
      sourceAttemptId: 'attempt-primary',
      recoveryMode: 'recovery_packet',
    });
  });
});

function permissionRequest(overrides: Partial<NormalizedCapabilityRequest> = {}): NormalizedCapabilityRequest {
  const request: NormalizedCapabilityRequest = {
    id: 'permission-1', fingerprint: '', taskId: 'task_1', generationId: 'generation_task_1_1',
    subtaskId: 'subtask_1', attemptId: 'attempt-1', agentClassName: 'codex-cli',
    permissionProfileId: 'workspace-engineering', capability: 'network_target', resource: 'https://example.com/data',
    partition: { kind: 'external_object', provider: 'https', account: 'public', collection: 'example.com', objectId: '443/data' },
    operation: 'GET', reason: 'read public task input', suggestedScope: 'attempt', distinctRequestOrdinal: 1,
    ...overrides,
  };
  request.fingerprint = capabilityRequestFingerprint(request);
  return request;
}

function runtimeEvent<T extends Omit<KernelEvent, keyof import('../../src/kernel/control-kernel.js').KernelEventEnvelope | 'schemaVersion' | 'id' | 'correlationId' | 'causationId' | 'occurredAt' | 'sessionId'>>(
  value: T,
): KernelEvent {
  return {
    schemaVersion: 5,
    configurationRevision,
    id: `event_${value.type}`,
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-07-20T00:00:00.000Z',
    sessionId: 'session_1',
    taskId: 'task_1',
    subtaskId: 'subtask_1',
    ...value,
  } as KernelEvent;
}

function dispatchSnapshot(
  attemptedBindingFingerprints: string[] = [],
  status: 'ready' | 'awaiting_integration' | 'awaiting_decision' | 'done' = 'ready',
): Extract<KernelSnapshot, { type: 'dispatch' }> {
  return {
    schemaVersion: 5,
    type: 'dispatch',
    task: { id: 'task_1', status: 'running' },
    runningTaskId: 'task_1',
    graphState: 'ready',
    subtasks: [{
      id: 'subtask_1', taskId: 'task_1', status,
      executorBindings: [codexBinding, piBinding],
    }],
    frontier: status === 'ready' ? ['subtask_1'] : [],
    dispatchItems: [],
    maxConcurrentAttempts: 4,
    availableSlots: 4,
    resourceConflictSubtaskIds: [],
    capacityProbeBindingFingerprints: { subtask_1: attemptedBindingFingerprints },
    executorStatuses: [],
    correctionSupportedAgentClasses: ['codex-cli'],
    nativeContinuationAgentClasses: ['codex-cli'],
    attempts: [],
    generationId: 'generation_task_1_1',
    graphRevision: 1,
    automaticReplansUsed: 0,
    recoverySafety: 'workspace_reconcilable',
    automaticRecoveryAllowed: true,
    resourceGrantsBySubtask: { subtask_1: [] },
    completionBlockedReasons: [],
    generationReplanRequest: null,
    generationQuiescent: true,
  };
}

function cancellationSubtask(
  id: string,
  status: Extract<KernelSnapshot, { type: 'task_control' }>['subtasks'][number]['status'],
  dependencySubtaskIds: string[] = [],
): Extract<KernelSnapshot, { type: 'task_control' }>['subtasks'][number] {
  return {
    id,
    taskId: 'task_1',
    status,
    executorBindings: [codexBinding],
    dependencySubtaskIds,
  };
}

function executionFailure(
  attemptId: string,
  authorizedBinding: AuthorizedExecutorBinding,
  attemptKind: 'primary' | 'continuation' | 'fallback',
  kind: 'network' | 'timeout' | 'task_failed',
  sourceAttemptId: string | null = null,
): Extract<KernelEvent, { type: 'execution_outcome' }> {
  return runtimeEvent({
    type: 'execution_outcome',
    terminalKind: 'failed',
    attemptId,
    authorizedBinding,
    bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
    attemptKind,
    sourceAttemptId,
    failure: {
      kind,
      scope: kind === 'task_failed' ? 'task' : 'agent_class',
      code: `${kind}_failure`,
      summary: `${kind} failure`,
    },
  }) as Extract<KernelEvent, { type: 'execution_outcome' }>;
}

function attemptFact(event: Extract<KernelEvent, { type: 'execution_outcome' }>) {
  return {
    attemptId: event.attemptId!,
    subtaskId: event.subtaskId!,
    authorizedBinding: event.authorizedBinding,
    bindingFingerprint: event.bindingFingerprint,
    attemptKind: event.attemptKind,
    sourceAttemptId: event.sourceAttemptId,
    terminalKind: event.terminalKind,
    failure: event.failure,
    completedAt: event.occurredAt,
  };
}
