import type { AgentClassRiskLevel, Subtask } from '../core/types.js';
import type {
  BuiltinExecutorName,
  PlannerExecutorCatalog,
  RoutingCapabilityId,
} from '../executor/builtin-executor-catalog.js';

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
export type TaskSemanticPriority = 'normal' | 'high' | 'urgent';

export interface SubtaskProposal {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  requiredCapabilities: RoutingCapabilityId[];
  preferredAgentClassList: BuiltinExecutorName[];
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
  schemaVersion: 3;
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
    priority: {
      level: TaskSemanticPriority;
      reason: string;
    } | null;
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
  initialContext: {
    longTermMemories: Array<{
      id: string;
      type: string;
      scope: string;
      subject: string | null;
      content: string;
    }>;
    conversationHistory: Array<{
      userInput: string;
      systemOutput: string;
      createdAt: string;
      source: string;
    }>;
  };
  request: {
    sessionId: string;
    source: string;
  };
  permissions: {
    allowDurableTask: boolean;
    allowFileModification: boolean;
    allowExternalGateway: boolean;
  };
  executorCatalog: PlannerExecutorCatalog;
  timeoutMs: number;
}
