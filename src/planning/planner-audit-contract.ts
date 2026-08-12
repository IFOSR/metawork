import type { PlannerProposalResult } from './planner-proposal.js';

export interface PlannerToolCallTrace {
  sequence: number;
  toolName: string;
  status: 'completed' | 'failed';
  argumentsSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
}

export interface PlannerRunResult {
  proposalResult: Extract<PlannerProposalResult, { status: 'accepted' }>;
  submittedPlan: unknown;
  toolCalls: PlannerToolCallTrace[];
  threadId: string | null;
  durationMs: number;
}
