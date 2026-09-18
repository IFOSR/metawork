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
  | 'abandon_task'
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
  conflictResolution?: {
    oldTaskId: string;
  } | null;
  workGraph: WorkGraphProposal | null;
  source: string;
}

/** Planner may use this bounded view to select an opaque attachment resource. */
export interface PlannerAttachmentView {
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
  availability: 'available' | 'unavailable';
}

/** @deprecated Planner no longer receives attachment bytes by default. */
export interface PlannerImageAttachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface PlanningContext {
  userInput: string;
  attachments?: PlannerAttachmentView[];
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
