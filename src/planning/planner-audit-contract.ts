import type {
  ExecutorManualProposalResult,
  PlannerProposalResult,
} from './planner-proposal.js';

export interface PlannerToolCallTrace {
  sequence: number;
  toolName: string;
  status: 'completed' | 'failed';
  argumentsSummary: Record<string, unknown>;
  resultSummary: Record<string, unknown>;
}

export interface PlannerRunResult {
  proposalResult?: PlannerProposalResult | ExecutorManualProposalResult;
  structuredOutput?: string;
  submittedPlan: unknown;
  toolCalls: PlannerToolCallTrace[];
  threadId: string | null;
  durationMs: number;
}

export type PlannerRunErrorCode = 'runtime_failure' | 'convergence_exhausted';
export type PlannerConvergenceReason = 'processing_cycles' | 'non_proposal_tool_calls';

export interface PlannerConvergenceDetails {
  reason: PlannerConvergenceReason;
  limit: number;
  observed: number;
}

export class PlannerRunError extends Error {
  readonly code: PlannerRunErrorCode;
  readonly toolCalls: PlannerToolCallTrace[];
  readonly threadId: string | null;
  readonly durationMs: number;
  readonly convergence?: PlannerConvergenceDetails;

  constructor(
    message: string,
    input: {
      toolCalls: PlannerToolCallTrace[];
      threadId: string | null;
      durationMs: number;
      code?: PlannerRunErrorCode;
      convergence?: PlannerConvergenceDetails;
      cause?: unknown;
    },
  ) {
    super(message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'PlannerRunError';
    this.code = input.code ?? 'runtime_failure';
    this.toolCalls = input.toolCalls;
    this.threadId = input.threadId;
    this.durationMs = input.durationMs;
    this.convergence = input.convergence;
  }
}

export function plannerRunFailureDetails(error: unknown): {
  toolCalls: PlannerToolCallTrace[];
  threadId: string | null;
  durationMs: number;
} | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    toolCalls?: unknown;
    threadId?: unknown;
    durationMs?: unknown;
  };
  if (!Array.isArray(candidate.toolCalls)
    || (candidate.threadId !== null && typeof candidate.threadId !== 'string')
    || typeof candidate.durationMs !== 'number'
    || !Number.isFinite(candidate.durationMs)
    || candidate.durationMs < 0) {
    return null;
  }
  return {
    toolCalls: candidate.toolCalls as PlannerToolCallTrace[],
    threadId: candidate.threadId,
    durationMs: candidate.durationMs,
  };
}
