import type { AgentClass } from '../core/types.js';
import type { ExecutorProfile } from '../core/executor-router.js';
import { IntentOrchestrator, type IntentDecisionV2, type IntentOrchestratorInput } from '../core/intent-orchestrator.js';
import { generateInteractionId } from '../utils/id.js';
import type { PlanningAgent } from './planning-agent.js';
import type { PlanningAgentPlan, PlanningContext, PlanningAction, WorkGraphProposal } from './planning-types.js';

export interface SemanticPlanningAgentDeps {
  intentOrchestrator?: {
    decide(input: IntentOrchestratorInput): Promise<IntentDecisionV2>;
  };
  createIntentOrchestrator(input: {
    executorProfiles: ExecutorProfile[];
    defaultExecutorName: string;
    timeoutMs: number;
  }): {
    decide(input: IntentOrchestratorInput): Promise<IntentDecisionV2>;
  };
}

export class SemanticPlanningAgent implements PlanningAgent {
  constructor(private readonly deps: SemanticPlanningAgentDeps) {}

  async plan(context: PlanningContext): Promise<PlanningAgentPlan> {
    const executorProfiles = context.agentClasses.map(agentClassToLegacyProfile);
    const intentOrchestrator = this.deps.intentOrchestrator ?? this.deps.createIntentOrchestrator({
      executorProfiles,
      defaultExecutorName: context.defaultExecutorName,
      timeoutMs: context.timeoutMs,
    });
    const decision = await intentOrchestrator.decide({
      userInput: context.userInput,
      recentTasks: context.recentTasks,
      executorProfiles,
      defaultExecutorName: context.defaultExecutorName,
      currentFocus: context.currentFocus,
      hints: context.hints,
      allowDurableTask: context.allowDurableTask,
      allowFileModification: context.allowFileModification,
      timeoutMs: context.timeoutMs,
    });

    return planningPlanFromIntentDecision(decision, context);
  }
}

export function createDefaultSemanticPlanningAgent(input: {
  llmBridge: Parameters<typeof IntentOrchestrator.createDefault>[0]['llmBridge'];
  intentOrchestrator?: SemanticPlanningAgentDeps['intentOrchestrator'];
}): SemanticPlanningAgent {
  return new SemanticPlanningAgent({
    intentOrchestrator: input.intentOrchestrator,
    createIntentOrchestrator: ({ executorProfiles, defaultExecutorName, timeoutMs }) =>
      IntentOrchestrator.createDefault({
        llmBridge: input.llmBridge,
        executorProfiles,
        defaultExecutorName,
        llmTimeoutMs: timeoutMs,
      }),
  });
}

export function planningPlanFromIntentDecision(
  decision: IntentDecisionV2,
  context: Pick<PlanningContext, 'userInput' | 'defaultExecutorName'>,
): PlanningAgentPlan {
  const action = actionFromIntentDecision(decision);
  const candidates = unique([
    decision.execution.selectedExecutor ?? '',
    ...decision.execution.candidateExecutors,
    context.defaultExecutorName,
  ]);
  const title = context.userInput.slice(0, 50) || 'Execute task';

  return {
    id: `plan_${generateInteractionId()}`,
    schemaVersion: 1,
    action,
    confidence: decision.confidence,
    reason: decision.reason,
    clarificationQuestion: decision.clarificationQuestion,
    response: {
      directReply: null,
    },
    task: {
      binding: decision.task.binding,
      taskId: decision.task.taskId,
      control: decision.task.control,
      scope: decision.task.scope,
      title,
      goal: context.userInput,
      includeRecentConversationContext: decision.execution.matchedBoundary?.includes('conversation_follow_up') ?? false,
    },
    execution: {
      mode: decision.execution.mode,
      complexity: decision.execution.complexity,
      selectedExecutor: decision.execution.selectedExecutor,
      candidateExecutors: candidates,
      requiresVerification: decision.execution.requiresVerification,
      canModifyFiles: decision.execution.canModifyFiles,
      requiresExternalGateway: decision.execution.requiresExternalGateway,
      capabilityClass: decision.execution.capabilityClass,
      matchedBoundary: decision.execution.matchedBoundary ?? [],
    },
    risk: {
      level: decision.risk.level,
      requiresConfirmation: decision.risk.requiresConfirmation,
      reasons: decision.risk.reasons,
    },
    workGraph: action === 'plan_work_graph'
      ? buildSingleSubtaskProposal({
          userInput: context.userInput,
          title,
          candidates,
          selectedExecutor: decision.execution.selectedExecutor,
          capabilityClass: decision.execution.capabilityClass,
          riskLevel: decision.risk.level === 'high' ? 'high' : decision.risk.level === 'medium' ? 'medium' : 'low',
        })
      : null,
    source: 'semantic-intent-adapter',
  };
}

function actionFromIntentDecision(decision: IntentDecisionV2): PlanningAction {
  if (decision.interactionType === 'durable_task' || decision.interactionType === 'executor_dispatch') {
    return 'plan_work_graph';
  }
  if (decision.interactionType === 'clarification') return 'clarification';
  if (decision.interactionType === 'direct_reply') return 'direct_reply';
  if (decision.interactionType === 'task_control') return 'task_control';
  return 'no_action';
}

function buildSingleSubtaskProposal(input: {
  userInput: string;
  title: string;
  candidates: string[];
  selectedExecutor: string | null;
  capabilityClass: string;
  riskLevel: 'low' | 'medium' | 'high';
}): WorkGraphProposal {
  const expectedOutput = input.capabilityClass === 'code_edit' ? 'patch' : 'summary';
  const candidateAgentClasses = unique([
    input.selectedExecutor ?? '',
    ...input.candidates,
  ]);
  return {
    reason: 'PlanningAgent proposed a single executor work graph',
    subtasks: [{
      id: 'subtask_execute',
      title: input.title || 'Execute task',
      goal: input.userInput,
      dependsOn: [],
      requiredAgentClassKind: 'executor',
      agentClassHint: candidateAgentClasses[0] ?? null,
      candidateAgentClasses,
      expectedOutput,
      acceptance: expectedOutput === 'patch'
        ? ['List changed files and provide test command output or explain why tests were not run.']
        : ['Satisfy the user request and report verification or remaining risk.'],
      riskLevel: input.riskLevel,
    }],
  };
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function agentClassToLegacyProfile(agentClass: AgentClass): ExecutorProfile {
  return {
    name: agentClass.name,
    domains: agentClass.domains,
    capabilities: agentClass.capabilities,
    inputTypes: agentClass.inputTypes,
    outputTypes: agentClass.outputTypes,
    strengths: agentClass.strengths,
    weaknesses: agentClass.weaknesses,
    primaryUseCases: agentClass.primaryUseCases,
    avoidUseCases: agentClass.avoidUseCases,
    intentAffinity: agentClass.intentAffinity,
    riskLevel: agentClass.riskLevel,
    availability: agentClass.availability,
    historicalSuccess: agentClass.historicalSuccess,
    runtimeCommand: agentClass.runtimeCommand,
    runtimeArgs: agentClass.runtimeArgs,
    runtimeCheckCommand: agentClass.runtimeCheckCommand,
    projectUrl: agentClass.projectUrl,
  };
}
