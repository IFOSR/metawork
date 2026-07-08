import type { AgentClass, AgentClassKind, AgentClassRiskLevel, Subtask } from '../core/types.js';
import type { RuleHint } from '../core/rule-hints-provider.js';
import type { TaskSummary } from '../core/llm-bridge.js';
import type { CapabilityClass } from '../core/capability-class.js';

export type PlanningAction =
  | 'direct_reply'
  | 'clarification'
  | 'task_control'
  | 'plan_work_graph'
  | 'no_action';

// Planning vocabulary shared across the PlanningAgent path. These string unions
// used to live in the retired core/intent-orchestrator module; they now have
// their home here on the live planning path.
export type IntentRiskLevel = 'low' | 'medium' | 'high';
export type IntentTaskBinding = 'new' | 'reference' | 'none';
export type IntentTaskControl =
  | 'clear_tasks'
  | 'status_query'
  | 'resume_task'
  | 'recover_blocked'
  | 'none';
export type IntentExecutionMode = 'none' | 'single_executor' | 'multi_executor';
export type IntentExecutionComplexity = 'simple' | 'moderate' | 'complex';

export interface SubtaskProposal {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  requiredAgentClassKind: AgentClassKind;
  agentClassHint: string | null;
  candidateAgentClasses: string[];
  expectedOutput: Subtask['expectedOutput'];
  acceptance: string[];
  riskLevel: AgentClassRiskLevel;
}

export interface WorkGraphProposal {
  reason: string;
  subtasks: SubtaskProposal[];
}

export interface PlanningAgentPlan {
  id: string;
  schemaVersion: 1;
  action: PlanningAction;
  confidence: number;
  reason: string;
  clarificationQuestion: string | null;
  response: {
    directReply: string | null;
  };
  task: {
    binding: IntentTaskBinding;
    taskId: string | null;
    control: IntentTaskControl;
    scope: string | null;
    title: string | null;
    goal: string | null;
    includeRecentConversationContext: boolean;
  };
  execution: {
    mode: 'none' | 'single_executor' | 'multi_executor';
    complexity: IntentExecutionComplexity;
    selectedExecutor: string | null;
    candidateExecutors: string[];
    requiresVerification: boolean;
    canModifyFiles: boolean;
    requiresExternalGateway: boolean;
    capabilityClass: CapabilityClass;
    matchedBoundary: string[];
  };
  risk: {
    level: IntentRiskLevel;
    requiresConfirmation: boolean;
    reasons: string[];
  };
  workGraph: WorkGraphProposal | null;
  source: string;
}

export interface PlanningContext {
  userInput: string;
  recentTasks: TaskSummary[];
  agentClasses: AgentClass[];
  defaultExecutorName: string;
  currentFocus: {
    kind: 'conversation' | 'task';
    taskId: string | null;
  } | null;
  hints: RuleHint[];
  allowDurableTask: boolean;
  allowFileModification: boolean;
  timeoutMs: number;
}
