import { vi } from 'vitest';
import type { PlanningAgent } from '../../src/planning/planning-agent.js';
import type {
  PlanningAgentPlan,
  SubtaskProposal,
  WorkGraphProposal,
} from '../../src/planning/planning-types.js';
import type {
  IntentTaskControl,
} from '../../src/core/intent-orchestrator.js';

// Test-only builders for PlanningAgentPlan. Full-stack/acceptance tests inject a
// PlanningAgent whose plan() returns one of these, exercising the real
// session -> PolicyKernel -> Runtime path with a deterministic plan instead of a
// mocked legacy IntentOrchestrator/llmBridge routing decision.

function basePlan(): PlanningAgentPlan {
  return {
    id: 'plan_test',
    schemaVersion: 1,
    action: 'direct_reply',
    confidence: 0.9,
    reason: 'test plan',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'none',
      taskId: null,
      control: 'none',
      scope: null,
      title: null,
      goal: null,
      includeRecentConversationContext: false,
    },
    execution: {
      mode: 'none',
      complexity: 'simple',
      selectedExecutor: null,
      candidateExecutors: [],
      requiresVerification: false,
      canModifyFiles: false,
      requiresExternalGateway: false,
      capabilityClass: 'conversation',
      matchedBoundary: [],
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: null,
    source: 'codex-planner',
  };
}

export function directReplyPlan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return { ...basePlan(), action: 'direct_reply', reason: '普通对话', ...overrides };
}

export function singleSubtaskWorkGraph(input: {
  goal: string;
  title?: string;
  executor?: string;
  expectedOutput?: SubtaskProposal['expectedOutput'];
  acceptance?: string[];
  riskLevel?: SubtaskProposal['riskLevel'];
}): WorkGraphProposal {
  const executor = input.executor ?? 'codex-cli';
  const expectedOutput = input.expectedOutput ?? 'patch';
  return {
    reason: 'single executor work graph',
    subtasks: [{
      id: 'subtask_execute',
      title: input.title ?? input.goal.slice(0, 50) ?? 'Execute task',
      goal: input.goal,
      dependsOn: [],
      requiredAgentClassKind: 'executor',
      agentClassHint: executor,
      candidateAgentClasses: [executor],
      expectedOutput,
      acceptance: input.acceptance ?? (expectedOutput === 'patch'
        ? ['List changed files and provide test command output or explain why tests were not run.']
        : ['Satisfy the user request and report verification or remaining risk.']),
      riskLevel: input.riskLevel ?? 'low',
    }],
  };
}

export function workGraphPlan(input: {
  goal: string;
  title?: string;
  executor?: string;
  capabilityClass?: PlanningAgentPlan['execution']['capabilityClass'];
  requiresVerification?: boolean;
  canModifyFiles?: boolean;
  matchedBoundary?: string[];
  includeRecentConversationContext?: boolean;
  expectedOutput?: SubtaskProposal['expectedOutput'];
  overrides?: Partial<PlanningAgentPlan>;
} ): PlanningAgentPlan {
  const executor = input.executor ?? 'codex-cli';
  // Default to a non-repo summary task: no repo test-evidence verifier gate, no
  // file modification. Code/repo tests opt in via capabilityClass 'code_edit',
  // expectedOutput 'patch', canModifyFiles/requiresVerification.
  const capabilityClass = input.capabilityClass ?? 'general';
  const expectedOutput = input.expectedOutput ?? (capabilityClass === 'code_edit' ? 'patch' : 'summary');
  return {
    ...basePlan(),
    action: 'plan_work_graph',
    reason: 'planner 产出工作图',
    task: {
      ...basePlan().task,
      binding: 'new',
      title: input.title ?? input.goal.slice(0, 50),
      goal: input.goal,
      includeRecentConversationContext: input.includeRecentConversationContext ?? false,
    },
    execution: {
      ...basePlan().execution,
      mode: 'single_executor',
      selectedExecutor: executor,
      candidateExecutors: [executor],
      requiresVerification: input.requiresVerification ?? false,
      canModifyFiles: input.canModifyFiles ?? (capabilityClass === 'code_edit'),
      capabilityClass,
      matchedBoundary: input.matchedBoundary ?? [],
    },
    workGraph: singleSubtaskWorkGraph({
      goal: input.goal,
      title: input.title,
      executor,
      expectedOutput,
    }),
    ...input.overrides,
  };
}

export function taskControlPlan(input: {
  control: IntentTaskControl;
  taskId?: string | null;
  scope?: string | null;
  reason?: string;
  overrides?: Partial<PlanningAgentPlan>;
}): PlanningAgentPlan {
  return {
    ...basePlan(),
    action: 'task_control',
    reason: input.reason ?? '任务控制',
    task: {
      ...basePlan().task,
      binding: input.taskId ? 'reference' : 'none',
      taskId: input.taskId ?? null,
      control: input.control,
      scope: input.scope ?? null,
    },
    ...input.overrides,
  };
}

export function clarificationPlan(question: string, overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    ...basePlan(),
    action: 'clarification',
    reason: '低置信度',
    confidence: 0.2,
    clarificationQuestion: question,
    ...overrides,
  };
}

// A PlanningAgent stub returning a fixed plan (or a queue of plans, one per turn).
export function stubPlanningAgent(...plans: PlanningAgentPlan[]): PlanningAgent & { plan: ReturnType<typeof vi.fn> } {
  const plan = vi.fn();
  if (plans.length <= 1) {
    plan.mockResolvedValue(plans[0] ?? directReplyPlan());
  } else {
    for (const value of plans) {
      plan.mockResolvedValueOnce(value);
    }
    plan.mockResolvedValue(plans[plans.length - 1]!);
  }
  return { plan } as PlanningAgent & { plan: ReturnType<typeof vi.fn> };
}
