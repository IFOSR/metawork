import type {
  RoutingCapabilityId,
} from '../routing/types.js';

export type WorkGraphItemType = 'text' | 'artifact';

export interface WorkGraphRequiredItem {
  key: string;
  type: WorkGraphItemType;
  description: string;
}

export interface WorkGraphDependency {
  fromSubtaskId: string;
  requiredItems: WorkGraphRequiredItem[];
}

export type ContextRef =
  | { kind: 'current_user_input' }
  | { kind: 'interaction'; interactionId: string; side: 'user' | 'assistant' }
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'task_resource'; locator: string }
  | { kind: 'task_evidence'; evidenceId: string }
  /**
   * Long-term memory recalled from the memory engine. Reaches the Executor only
   * through the evidence channel; it is never spliced into the prompt body.
   */
  | { kind: 'memory'; memoryId: string; revision?: string };

export interface WorkGraphAcceptanceCriterion {
  key: string;
  description: string;
  requiredEvidence: string[];
}

export interface WorkGraphSubtask {
  id: string;
  title: string;
  goal: string;
  dependencies: WorkGraphDependency[];
  contextRefs: ContextRef[];
  requiredCapabilities: RoutingCapabilityId[];
  /** Absent on historical graphs; unknown keeps exclusive execution. */
  workspaceEffect?: 'read_only' | 'write' | 'unknown';
  deliveryKind: 'edit' | 'report';
  /** Required in new proposals. Absent only on graphs authorized before schema 50. */
  fileOutputs?: string[];
  acceptance: WorkGraphAcceptanceCriterion[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface WorkGraphProposal {
  schemaVersion: 7;
  configurationRevision: string;
  reason: string;
  subtasks: WorkGraphSubtask[];
}
