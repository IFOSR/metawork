import type { AgentClass, AgentClassKind, AgentClassRiskLevel, Subtask } from '../core/types.js';
import type {
  IntentExecutionComplexity,
  IntentRiskLevel,
  IntentTaskBinding,
  IntentTaskControl,
} from '../core/intent-orchestrator.js';
import type { RuleHint } from '../core/rule-hints-provider.js';
import type { TaskSummary } from '../core/llm-bridge.js';
import type { CapabilityClass } from '../core/capability-class.js';

export type PlanningAction =
  | 'direct_reply'
  | 'clarification'
  | 'task_control'
  | 'plan_work_graph'
  | 'no_action';

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
