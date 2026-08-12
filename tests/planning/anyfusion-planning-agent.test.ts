import { describe, expect, it, vi } from 'vitest';
import type { PlannerConfigurationView } from '../../src/configuration/index.js';
import type { RevisionedAgentBinding } from '../../src/core/authorized-executor-binding.js';
import { AnyFusionPlanningAgent } from '../../src/planning/anyfusion-planning-agent.js';
import type { PlannerProposalResult } from '../../src/planning/planner-proposal.js';
import type { PlanningContext } from '../../src/planning/planning-types.js';

const configuration: PlannerConfigurationView = {
  revisionId: 'revision-test',
  contentHash: 'sha256:planner-view',
  models: [{
    id: 'engineering-model',
    capabilities: ['coding', 'tools'],
    reasoning: 'high',
    region: 'international',
  }],
  routingCatalog: {
    version: 2,
    configurationRevision: 'revision-test',
    capabilities: [{
      id: 'workspace-engineering',
      deliveryContract: 'Modify and verify workspace files.',
    }],
    agentClasses: [{
      id: 'custom-engineering',
      routingCapabilities: ['workspace-engineering'],
      primaryUseCases: ['implementation'],
      avoidUseCases: [],
      affordances: ['workspace-command-validation', 'workspace-read-write'],
      modelPolicy: { mode: 'fixed', modelRef: 'engineering-model' },
    }],
  },
};

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  return {
    userInput: '实现一个功能',
    request: { sessionId: 'session_test', source: 'test' },
    pendingAuthorizationRequest: null,
    configuration,
    timeoutMs: 5_000,
    ...overrides,
  };
}

const VALID_PLAN = {
  id: 'plan_1',
  schemaVersion: 8,
  action: 'plan_work_graph',
  confidence: 0.9,
  reason: '需要执行',
  clarificationQuestion: null,
  response: { directReply: null },
  task: {
    binding: 'new', taskId: null, control: 'none', scope: null,
    title: '重构', goal: '重构并测试', includeRecentConversationContext: false,
    priority: { level: 'high', reason: '用户要求优先完成' },
  },
  risk: { level: 'medium', requiresConfirmation: false, reasons: [] },
  authorizationResolution: null,
  workGraph: {
    schemaVersion: 7,
    configurationRevision: 'revision-test',
    reason: '单步执行',
    subtasks: [{
      id: 'impl', title: '实现', goal: '实现并测试', dependencies: [],
      contextRefs: [{ kind: 'current_user_input' }],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [{
        agentClassRef: 'custom-engineering',
        modelSelection: { mode: 'fixed-by-agent-class' },
      }],
      deliveryKind: 'edit',
      acceptance: [{ key: 'tests_pass', description: '测试通过', requiredEvidence: ['test result'] }],
      riskLevel: 'medium',
    }],
  },
  source: 'anyfusion-planner',
} as const;

const plannerBinding: RevisionedAgentBinding = {
  agentClassRef: 'anyfusion-planner',
  harnessRef: 'anyfusion-planner-host',
  providerRef: 'planner-provider',
  modelRef: 'planner-model',
  permissionProfileRef: null,
  configurationRevision: 'revision-test',
};

function accepted(outcome = 'proposal_validated'): Extract<PlannerProposalResult, { status: 'accepted' }> {
  return {
    status: 'accepted', turnId: 'turn-1', submissionId: 'submission-1', planId: 'plan_1',
    outcome: outcome as never, displayText: 'accepted', taskId: null, kernel: null,
  };
}

function runner(result = accepted()) {
  return {
    run: vi.fn(async () => ({
      proposalResult: result,
      submittedPlan: VALID_PLAN,
      toolCalls: [{
        sequence: 1, toolName: 'submit_planning_proposal', status: 'completed' as const,
        argumentsSummary: {}, resultSummary: {},
      }],
      threadId: null,
      durationMs: 1,
    })),
  };
}

describe('AnyFusionPlanningAgent native proposal tool adapter', () => {
  it('sends only the current input and returns a MetaClaw-validated tool argument for internal planning', async () => {
    const plannerRunner = runner();
    const agent = new AnyFusionPlanningAgent({ runner: plannerRunner });

    const result = await agent.plan(context());

    expect(result).toMatchObject({ id: 'plan_1', schemaVersion: 8, action: 'plan_work_graph' });
    expect(plannerRunner.run).toHaveBeenCalledWith('实现一个功能', expect.any(Object), 'validation');
    expect(plannerRunner.run).toHaveBeenCalledTimes(1);
  });

  it('returns the authoritative Kernel result for user-facing RPC turns without resubmission', async () => {
    const kernelAccepted = accepted('direct_reply_delivered');
    const plannerRunner = runner(kernelAccepted);
    const agent = new AnyFusionPlanningAgent({ runner: plannerRunner });

    await expect(agent.submit(context())).resolves.toEqual(kernelAccepted);
    expect(plannerRunner.run).toHaveBeenCalledWith('实现一个功能', expect.any(Object), 'kernel');
    expect(plannerRunner.run).toHaveBeenCalledTimes(1);
  });

  it('does not add an outer repair loop when the structured runner fails', async () => {
    const plannerRunner = { run: vi.fn(async () => { throw new Error('agent ended after rejection'); }) };
    const agent = new AnyFusionPlanningAgent({ runner: plannerRunner as never });

    await expect(agent.plan(context())).rejects.toThrow('agent ended after rejection');
    expect(plannerRunner.run).toHaveBeenCalledTimes(1);
    await expect(agent.submit(context())).resolves.toMatchObject({
      status: 'transport_uncertain', retryableByReplay: true,
    });
    expect(plannerRunner.run).toHaveBeenCalledTimes(2);
  });

  it('keeps audit failure best-effort and counts native proposal tool calls', async () => {
    const audit = {
      start: vi.fn(() => ({ id: 'planner_run_test' })),
      finish: vi.fn(() => { throw new Error('database is locked'); }),
    };
    const resolvePlannerAuditBinding = vi.fn(async () => ({
      plannerBinding,
      plannerBindingFingerprint: 'sha256:planner-binding',
    }));
    const agent = new AnyFusionPlanningAgent({
      runner: runner(),
      audit,
      resolvePlannerAuditBinding,
    });

    await expect(agent.plan(context())).resolves.toMatchObject({ id: 'plan_1' });
    expect(resolvePlannerAuditBinding).toHaveBeenCalledWith('revision-test');
    expect(audit.start).toHaveBeenCalledWith({
      sessionId: 'session_test',
      requestSource: 'test',
      configurationRevision: 'revision-test',
      plannerBinding,
      plannerBindingFingerprint: 'sha256:planner-binding',
    });
    expect(audit.finish).toHaveBeenCalledWith(expect.objectContaining({
      id: 'planner_run_test', status: 'completed', attemptCount: 1,
    }));
  });

  it('does not persist an audit run when the injected Planner binding has a different revision', async () => {
    const audit = {
      start: vi.fn(() => ({ id: 'planner_run_test' })),
      finish: vi.fn(),
    };
    const agent = new AnyFusionPlanningAgent({
      runner: runner(),
      audit,
      resolvePlannerAuditBinding: vi.fn(async () => ({
        plannerBinding: {
          ...plannerBinding,
          configurationRevision: 'revision-stale',
        },
        plannerBindingFingerprint: 'sha256:stale-planner-binding',
      })),
    });

    await expect(agent.plan(context())).resolves.toMatchObject({ id: 'plan_1' });
    expect(audit.start).not.toHaveBeenCalled();
    expect(audit.finish).not.toHaveBeenCalled();
  });
});
