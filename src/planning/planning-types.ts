import type { PlannerConfigurationView } from '../configuration/index.js';
import type { WorkGraphProposal, WorkGraphSubtask } from '../work-graph/index.js';

export type PlanningAction =
  | 'direct_reply'
  | 'clarification'
  | 'task_control'
  | 'plan_work_graph'
  | 'authorization_resolution'
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

export type SubtaskProposal = WorkGraphSubtask;
export type { WorkGraphProposal };

export interface PlanningAgentPlan {
  id: string;
  schemaVersion: 8;
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
  authorizationResolution: {
    requestId: string;
    resolution: 'approve' | 'deny';
  } | null;
  workGraph: WorkGraphProposal | null;
  source: string;
}

/** 随用户输入提交给 Planner 的多模态图片（base64，Pi RPC images 协议）。 */
export interface PlannerImageAttachment {
  /** 原始文件名，供 Planner 在提案中引用。 */
  name: string;
  mimeType: string;
  /** base64 编码的图片内容。 */
  data: string;
}

export interface PlanningContext {
  userInput: string;
  /** 多模态图片附件；Planner 进程以 RPC images 通道原生消费。 */
  images?: PlannerImageAttachment[];
  request: {
    sessionId: string;
    /** Semantic Conversation owner; distinct from the Planner session identity. */
    conversationId?: string;
    source: string;
  };
  pendingAuthorizationRequest: {
    requestId: string;
    taskId: string;
    capability: string;
    resource: string;
    operation: string;
    reason: string;
  } | null;
  configuration: PlannerConfigurationView;
  timeoutMs: number;
}
