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
  | { kind: 'task_resource'; locator: string }
  | { kind: 'task_evidence'; evidenceId: string }
  | { kind: 'preference'; preferenceId: string };

export interface WorkGraphAcceptanceCriterion {
  key: string;
  description: string;
  requiredEvidence: string[];
}

export type ProposedModelSelection =
  | { mode: 'fixed-by-agent-class' }
  | { mode: 'proposed'; modelRef: string; reason: string }
  | { mode: 'agent-class-default' };

export interface ProposedExecutorBinding {
  agentClassRef: string;
  modelSelection: ProposedModelSelection;
}

export interface WorkGraphSubtask {
  id: string;
  title: string;
  goal: string;
  dependencies: WorkGraphDependency[];
  contextRefs: ContextRef[];
  requiredCapabilities: RoutingCapabilityId[];
  executorBindings: ProposedExecutorBinding[];
  deliveryKind: 'edit' | 'report';
  acceptance: WorkGraphAcceptanceCriterion[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface WorkGraphProposal {
  schemaVersion: 7;
  configurationRevision: string;
  reason: string;
  subtasks: WorkGraphSubtask[];
}
