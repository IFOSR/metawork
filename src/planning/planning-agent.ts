import type { PlannerProposalResult } from './planner-proposal.js';
import type { PlannerRunProgressObserver } from './planner-progress.js';
import type { HarnessUsageEvent } from '../executor/harness-driver.js';
import type { PlannerConfigurationView } from '../configuration/index.js';
import type { PlanningAgentPlan, PlanningContext } from './planning-types.js';

export interface PlanningProposalSubmitter {
  submit(plan: PlanningAgentPlan): Promise<PlannerProposalResult>;
  onProgress?: PlannerRunProgressObserver;
  onUsage?: (event: HarnessUsageEvent) => void;
}

export interface ManagerSummaryInput {
  readonly conversationId: string;
  readonly taskId: string;
  readonly workspaceRoot: string;
  readonly userInput: string;
  readonly configuration: PlannerConfigurationView;
  readonly results: readonly { readonly title: string; readonly content: string }[];
  readonly signal?: AbortSignal;
  readonly onUsage?: (event: HarnessUsageEvent) => void;
}

export interface PlanningAgent {
  /** Run a user-facing turn whose proposal is submitted to MetaClaw in the same Pi ReAct loop. */
  submit(context: PlanningContext, submitter: PlanningProposalSubmitter): Promise<PlannerProposalResult>;

  /** Generate an internally requested proposal through the same tool, validated by MetaClaw before return. */
  plan(context: PlanningContext): Promise<PlanningAgentPlan>;

  /** Manager-owned semantic answer after certified Subtask results are available. */
  summarizeTask?(input: ManagerSummaryInput): Promise<string>;
}
