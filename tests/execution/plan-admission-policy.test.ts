import { describe, expect, it } from 'vitest';
import { authorizePlanAdmission, type PlanAdmissionRequest, type PlanAdmissionSnapshot } from '../../src/execution/plan-admission-policy.js';
import { decideDeferredPlanActivation } from '../../src/execution/deferred-plan-activation-policy.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';
import { configurationRevision, plannerConfiguration, kernelConfiguration, codexBinding, event, snapshot } from '../support/plan-admission-fixture.js';

describe('Task Runtime plan admission', () => {
  it('returns the same result without event or decision envelopes', () => {

    const first = authorizePlanAdmission(event, snapshot);
    const second = authorizePlanAdmission(event, snapshot);

    expect(first).toEqual(second);
    // Direct reply was removed from the plan contract; a no-op proposal now
    // produces the durable conclusion without any event/decision envelope.
    expect(first).toEqual({
      status: 'no_action',
      reason: 'no runtime action required',
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
    const replanEvent: PlanAdmissionRequest = {
      ...event,
      id: 'event_replan_1',
      taskId: 'task_1',
      proposal,
      generationId: 'generation_1',
      proposalSource: 'replan',
      targetGraphRevision: 2,
    };
    const replanSnapshot: PlanAdmissionSnapshot = {
      ...snapshot,
      tasks: [{ id: 'task_1', status: 'running' }],
      runningTaskId: 'task_1',
      v5WorkGraphTaskIds: ['task_1'],
    };

    expect(authorizePlanAdmission(replanEvent, replanSnapshot)).toMatchObject({
      status: 'authorized', taskId: 'task_1', generationId: 'generation_1',
      graphRevision: 2, proposalSource: 'replan',
    });
  });

  it('admits executable Tasks from different Conversations independently', () => {
    const proposal = workGraphPlan({ goal: 'Run task B', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = authorizePlanAdmission({
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

    expect(decision).toMatchObject({
      status: 'authorized',
      scheduleState: 'eligible',
    });
  });

  it('authorizes a second initial Task from one Conversation as queued', () => {
    const proposal = workGraphPlan({ goal: 'Run task B', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = authorizePlanAdmission({
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

    expect(decision).toMatchObject({
      status: 'authorized',
      scheduleState: 'queued',
    });
  });

  it('rejects same-Conversation admission when the durable queue is full', () => {
    const proposal = workGraphPlan({ goal: 'Run task B', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const decision = authorizePlanAdmission({
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

    expect(decision.status).toBe('rejected');
    expect(decision.reason).toContain('queue limit reached');
  });

  it('retains all hard-eligible models across Providers for Router selection', () => {
    const proposal = workGraphPlan({
      goal: 'Implement the requested change',
      capabilityClass: 'code_edit',
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];

    const planner = structuredClone(plannerConfiguration);
    planner.models.push({
      id: 'codex-fast',
      providerRef: 'secondary',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',
      region: 'international',
    });
    const codexCatalog = planner.routingCatalog.agentClasses.find(
      agentClass => agentClass.id === 'pi-engineering-fixture',
    )!;
    codexCatalog.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['codex-model', 'codex-fast'],
      defaultModelRef: 'codex-fast',
    };

    const kernel = structuredClone(kernelConfiguration);
    kernel.models['codex-fast'] = {
      providerRef: 'secondary',
      modelId: 'gpt-5.6-fast',
      capabilities: ['coding', 'tools'],
      reasoning: 'high',

      enabled: true,
    };
    kernel.agentClasses['pi-engineering-fixture']!.modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['codex-model', 'codex-fast'],
      defaultModelRef: 'codex-fast',
    };

    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_cross_provider_auto',
      proposal,
      generationId: 'generation_cross_provider',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      plannerConfiguration: planner,
      configuration: kernel,
    });

    expect(decision).toMatchObject({
      status: 'authorized',
      authorizedBindingsBySubtask: {
        subtask_execute: [{ agentClassRef: 'pi-agent', modelRef: 'pi-model' }, {
          providerRef: 'secondary',
          modelRef: 'codex-fast',
        }, { providerRef: 'openai', modelRef: 'codex-model' }],
      },
      routing: {
        subtask_execute: [{ binding: { modelRef: 'pi-model' } }, {
          binding: {
            providerRef: 'secondary',
            modelRef: 'codex-fast',
          },
        }, { binding: { modelRef: 'codex-model' } }],
      },
    });
  });

  it('requires and selects an image-capable model for image generation work', () => {
    const proposal = workGraphPlan({
      goal: '生成一张产品概念图',
      executor: 'pi-agent',
      deliveryKind: 'edit',
      fileOutputs: ['images'],
    });
    const subtask = proposal.workGraph!.subtasks[0]!;
    subtask.contextRefs = [];
    subtask.requiredCapabilities = ['image-generation'];

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

    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_image_generation',
      proposal,
      generationId: 'generation_image_generation',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      plannerConfiguration: planner,
      configuration: kernel,
    });

    expect(decision).toMatchObject({
      status: 'authorized',
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
      fileOutputs: [],
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

    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_pi_current_web_research',
      proposal,
      generationId: 'generation_pi_current_web_research',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      configuration: deepseekConfiguration,
    });

    expect(decision).toMatchObject({
      status: 'authorized',
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
      executor: 'pi-engineering-fixture',
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];

    const configuration = structuredClone(kernelConfiguration);
    configuration.models['codex-model'] = {
      ...configuration.models['codex-model']!,
      capabilities: [],
    };

    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_empty_model_profile',
      proposal,
      generationId: 'generation_empty_model_profile',
      targetGraphRevision: 1,
    }, {
      ...snapshot,
      configuration: configuration,
    });

    expect(decision).toMatchObject({
      status: 'authorized',
      authorizedBindingsBySubtask: {
        subtask_execute: [{ agentClassRef: 'pi-agent', modelRef: 'pi-model' }, {
          agentClassRef: 'pi-engineering-fixture',
          modelRef: 'codex-model',
        }],
      },
    });
  });

  it('names an unqualified attachment reference as 附件 in the clarification', () => {
    const proposal = workGraphPlan({ goal: '分析附件' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [
      { kind: 'attachment', attachmentId: 'att_missing' },
    ];

    const decision = authorizePlanAdmission({ ...event, proposal }, {
      ...snapshot,
      eligibleContextRefKeys: [],
    });

    expect(decision).toMatchObject({ status: 'clarification' });
    const question = decision.status === 'clarification'
      ? decision.question
      : '';
    expect(question).toContain('（附件）');
    expect(question).not.toContain('attachment');
    expect(decision.reason).toContain('attachment:att_missing');
  });

  it('admits an attachment reference that belongs to the current Turn', () => {
    const proposal = workGraphPlan({ goal: '分析附件' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [
      { kind: 'attachment', attachmentId: 'att_current' },
    ];

    expect(authorizePlanAdmission({ ...event, proposal }, {
      ...snapshot,
      eligibleContextRefKeys: ['attachment:att_current'],
    })).toMatchObject({ status: 'authorized' });
  });

  it('rejects an empty non-null task reference instead of authorizing it as a new Task', () => {
    const proposal = workGraphPlan({ goal: 'Create an artifact' });
    proposal.task.taskId = '';

    expect(authorizePlanAdmission({ ...event, proposal }, {
      ...snapshot,
      eligibleContextRefKeys: ['current_user_input'],
    })).toMatchObject({
      status: 'rejected',
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
    const replanEvent: PlanAdmissionRequest = {
      ...event,
      id: 'event_replan_waiting',

      taskId: 'task_1',
      proposal,
      generationId: 'generation_1',
      proposalSource: 'replan',
      targetGraphRevision: 2,
      availabilityExplanation: 'The configured Executors are currently unavailable.',
    };
    const errorStatuses = ['pi-engineering-fixture', 'pi-agent'].map(agentClassName => ({
      agentClassName,
      classHealth: 'error' as const,
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: event.occurredAt,
    }));
    const admission: PlanAdmissionSnapshot = {
      ...snapshot,
      tasks: [{ id: 'task_1', status: 'running' }],
      runningTaskId: 'task_1',
      executorStatuses: errorStatuses,
      v5WorkGraphTaskIds: ['task_1'],
    };
    expect(authorizePlanAdmission(replanEvent, admission)).toMatchObject({
      status: 'deferred',
      taskId: 'task_1',
      explanation: 'The configured Executors are currently unavailable.',
    });

    const recoveredName = 'pi-engineering-fixture';
    // Activation is Task Runtime policy now (ADR-0055 §6); the Kernel no longer
    // decides it, so this assertion moved to deferred-plan-activation-policy.
    const activation = decideDeferredPlanActivation({
      replanRequestId: 'replan_request_1',
      observedAt: '2026-07-30T00:00:00.000Z',
      snapshot: {
        task: { id: 'task_1', status: 'needs_action' },
        activeGenerationId: 'generation_1',
        activeGraphRevision: 1,
        deferredPlan: replanEvent,
        deferredBindings: { subtask_execute: [codexBinding] },
        executorStatuses: errorStatuses.map(status => status.agentClassName === recoveredName
          ? { ...status, classHealth: 'healthy' as const }
          : status),
      },
    });
    expect(activation).toMatchObject({
      authorized: true,
      activation: {
        taskId: 'task_1',
        replanRequestId: 'replan_request_1',
        generationId: 'generation_1',
        graphRevision: 2,
      },
    });
  });

});

describe('Plan admission abandon_task authorization (2026-09-06 plan §5.4)', () => {
  const taskControlProposal = (control: string, taskId: string | null) => ({
    ...event,
    id: `event_${control}_${taskId ?? 'none'}`,
    proposal: {
      ...event.proposal,
      id: `plan_${control}`,
      action: 'task_control',
      task: {
        binding: taskId ? 'reference' : 'none',
        taskId,
        control,
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
    },
  });

  it('authorizes abandoning the slot-occupying Task of the current Conversation', () => {
    const decision = authorizePlanAdmission(
      taskControlProposal('abandon_task', 'task-old') as PlanAdmissionRequest,
      {
        ...snapshot,
        tasks: [{ id: 'task-old', status: 'needs_action', conversationId: 'session_1' }],
        activeTaskByConversation: { session_1: 'task-old' },
      },
    );
    expect(decision).toMatchObject({
      status: 'task_control',
      task: { control: 'abandon_task', taskId: 'task-old' },
    });
  });

  it('authorizes abandoning a queued (non-slot) Task of the current Conversation', () => {
    const decision = authorizePlanAdmission(
      taskControlProposal('abandon_task', 'task-queued') as PlanAdmissionRequest,
      {
        ...snapshot,
        tasks: [{ id: 'task-queued', status: 'created', conversationId: 'session_1' }],
        activeTaskByConversation: { session_1: 'task-other' },
      },
    );
    expect(decision).toMatchObject({ status: 'task_control' });
  });

  it('rejects abandoning a Task owned by another Conversation', () => {
    const decision = authorizePlanAdmission(
      taskControlProposal('abandon_task', 'task-foreign') as PlanAdmissionRequest,
      {
        ...snapshot,
        tasks: [{ id: 'task-foreign', status: 'needs_action', conversationId: 'conversation-b' }],
        activeTaskByConversation: {},
      },
    );
    expect(decision).toMatchObject({ status: 'rejected' });
    expect(decision.reason).toContain('another Conversation');
  });

  it('rejects abandoning an invented Task id', () => {
    const decision = authorizePlanAdmission(
      taskControlProposal('abandon_task', 'task-invented') as PlanAdmissionRequest,
      { ...snapshot, tasks: [] },
    );
    expect(decision).toMatchObject({ status: 'rejected' });
    expect(decision.reason).toContain('task not found');
  });

  it('still rejects a resume control while the slot is occupied by another Task', () => {
    const proposal = taskControlProposal('resume_task', 'task-queued');
    proposal.proposal.task.priority = { level: 'normal', reason: 'explicit resume' };
    const decision = authorizePlanAdmission(proposal as PlanAdmissionRequest, {
      ...snapshot,
      tasks: [{ id: 'task-queued', status: 'queued', conversationId: 'session_1' }],
      activeTaskByConversation: { session_1: 'task-other' },
    });
    expect(decision).toMatchObject({ status: 'rejected' });
    expect(decision.reason).toContain('slot is occupied');
  });
});

describe('Plan admission conflictResolution (2026-09-06 plan §5.4 abandon-and-create)', () => {
  const conflictPlan = (oldTaskId: string) => {
    const proposal = workGraphPlan({ goal: 'New work', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    proposal.conflictResolution = { oldTaskId };
    return proposal;
  };

  it('authorizes the new plan as queued and carries the old Task identity', () => {
    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_conflict_resolution',
      conversationId: 'session_1',
      proposal: conflictPlan('task-old'),
      generationId: 'generation_conflict',
    }, {
      ...snapshot,
      tasks: [{ id: 'task-old', status: 'needs_action' }],
      activeTaskByConversation: { session_1: 'task-old' },
      occupiedConversationIds: ['session_1'],
      queuedTaskCountByConversation: { session_1: 0 },
    });

    expect(decision).toMatchObject({
      status: 'authorized',
      scheduleState: 'queued',
      conflictResolution: { oldTaskId: 'task-old' },
    });
  });

  it('rejects an unknown old Task id', () => {
    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_conflict_unknown',
      conversationId: 'session_1',
      proposal: conflictPlan('task-missing'),
      generationId: 'generation_conflict_unknown',
    }, {
      ...snapshot,
      tasks: [{ id: 'task-other', status: 'needs_action' }],
      activeTaskByConversation: { session_1: 'task-other' },
    });
    expect(decision).toMatchObject({ status: 'rejected' });
    expect(decision.reason).toContain('unknown Task');
  });

  it('rejects an already-terminal old Task', () => {
    const decision = authorizePlanAdmission({
      ...event,
      id: 'event_conflict_terminal',
      conversationId: 'session_1',
      proposal: conflictPlan('task-done'),
      generationId: 'generation_conflict_terminal',
    }, {
      ...snapshot,
      tasks: [{ id: 'task-done', status: 'succeeded' }],
      activeTaskByConversation: { session_1: 'task-done' },
    });
    expect(decision).toMatchObject({ status: 'rejected' });
    expect(decision.reason).toContain('already-terminal');
  });
});

describe('admission conclusions without a ledger', () => {
  const request = () => {
    const proposal = workGraphPlan({ goal: 'Implement the request', capabilityClass: 'code_edit' });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    return { ...structuredClone(event), proposal };
  };

  it('preserves the explicit clarification and no-action conclusions', () => {
    const clarification = structuredClone(event);
    clarification.proposal.action = 'clarification';
    clarification.proposal.clarificationQuestion = 'Which directory?';
    expect(authorizePlanAdmission(clarification, snapshot)).toMatchObject({ status: 'clarification', question: 'Which directory?' });
    clarification.proposal.action = 'no_action';
    clarification.proposal.clarificationQuestion = null;
    expect(authorizePlanAdmission(clarification, snapshot).status).toBe('no_action');
  });

  it('asks for confirmation before admitting a risky or low-confidence change', () => {
    const input = request();
    input.proposal.risk.requiresConfirmation = true;
    expect(authorizePlanAdmission(input, snapshot)).toMatchObject({ status: 'clarification', reason: 'risk confirmation required' });
    input.proposal.risk.requiresConfirmation = false;
    input.proposal.confidence = 0.4;
    expect(authorizePlanAdmission(input, snapshot)).toMatchObject({ status: 'clarification', reason: 'low confidence state-changing plan' });
  });

  it.each([{ generationId: '' }, { targetGraphRevision: 0 }, { targetGraphRevision: 2 }, { targetGraphRevision: 1.5 }])(
    'rejects an invalid initial graph identity %j', override => {
      expect(authorizePlanAdmission({ ...request(), ...override }, snapshot).status).toBe('rejected');
    },
  );

  it('does not create a Task for missing or cross-Workspace access facts', () => {
    const input = request();
    input.workspaceAdmission = { targetWorkspace: null };
    expect(authorizePlanAdmission(input, snapshot).status).toBe('clarification');
    input.workspaceAdmission = structuredClone(event.workspaceAdmission);
    input.proposal.workspaceIntent!.targetWorkspaceId = 'workspace_other';
    expect(authorizePlanAdmission(input, snapshot).status).toBe('rejected');
  });

  it('refuses initial execution when its only eligible AgentClass is disabled', () => {
    const facts = structuredClone(snapshot);
    facts.executorStatuses = ['pi-engineering-fixture', 'pi-agent'].map(agentClassName => ({ agentClassName, classHealth: 'disabled', recentAttempts: [], recentRecoveryChecks: [], updatedAt: event.occurredAt }));
    expect(authorizePlanAdmission(request(), facts)).toMatchObject({ status: 'rejected', reason: 'no healthy canonical AgentClass remains' });
  });

  it('validates the exact pending permission identity before accepting its interpretation', () => {
    const input = structuredClone(event);
    input.proposal.action = 'authorization_resolution';
    input.proposal.task.binding = 'reference';
    input.proposal.task.taskId = 'task_1';
    input.proposal.authorizationResolution = { requestId: 'permission_1', resolution: 'approve' };
    const facts = { ...snapshot, pendingAuthorizationRequest: { requestId: 'permission_1', taskId: 'task_1' } };
    expect(authorizePlanAdmission(input, facts)).toMatchObject({ status: 'permission_resolution', taskId: 'task_1', requestId: 'permission_1', resolution: 'approve' });
    expect(authorizePlanAdmission(input, snapshot).status).toBe('rejected');
    expect(authorizePlanAdmission(input, { ...facts, pendingAuthorizationRequest: { requestId: 'other', taskId: 'task_1' } }).status).toBe('rejected');
  });
});
