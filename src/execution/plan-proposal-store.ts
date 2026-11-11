import type { PlanAdmissionRequest } from './plan-admission-policy.js';

/** Immutable Manager output. This is input to admission, never execution authority. */
export interface PlanProposalRecord {
  request: PlanAdmissionRequest;
  operationId: string;
  replanRequestId: string | null;
  triggerOperationId: string | null;
  delivery: 'pending' | 'forwarded' | 'invalidated';
  deliveryReason: string | null;
}

/** Task Runtime owns the proposal and durable delivery intent, not a decision ledger. */
export interface PlanProposalStore {
  save(input: {
    request: PlanAdmissionRequest;
    replanRequestId?: string;
    triggerOperationId?: string;
  }): PlanProposalRecord;
  find(id: string): PlanProposalRecord | null;
  /** Recheck durable lifecycle fences before applying saved input. */
  assertAdmissionOpen(id: string): void;
  findForReplan(replanRequestId: string): PlanProposalRecord | null;
  /** Set only after Task creation; raw/unadmitted proposals cannot grant attachments. */
  bindInitialToTask(taskId: string, proposalId: string): void;
  /** Original Task input; the binding is not graph or execution authority. */
  findInitialForTask(taskId: string): PlanProposalRecord | null;
  listPendingReplans(limit: number): PlanProposalRecord[];
  recordDeliveryFailure(id: string, now: string): void;
  markForwarded(id: string, now: string): boolean;
  invalidate(id: string, reason: string, now: string): boolean;
}

export class PlanProposalUnavailableError extends Error {
  constructor(readonly code: 'proposal_missing' | 'proposal_invalidated' | 'conversation_deleted' | 'turn_cancelled') {
    super(code);
    this.name = 'PlanProposalUnavailableError';
  }
}

export function proposedTaskId(request: Pick<PlanAdmissionRequest, 'id' | 'proposal'>): string {
  return request.proposal.task.taskId ?? `task_${request.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Trusted preparation is pinned by the first save, never regenerated on replay. */
export function planProposalIdentity(input: PlanAdmissionRequest): string {
  const { occurredAt, workspaceAdmission, ...identity } = planAdmissionRequest(input);
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]));
    }
    return value;
  };
  return JSON.stringify(canonical(identity));
}

/** Drop transport metadata rather than persisting a ControlEvent as domain input. */
export function planAdmissionRequest(input: PlanAdmissionRequest): PlanAdmissionRequest {
  return {
    id: input.id,
    configurationRevision: input.configurationRevision,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.sourceTurnId !== undefined ? { sourceTurnId: input.sourceTurnId } : {}),
    ...(input.queryId !== undefined ? { queryId: input.queryId } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    proposal: input.proposal,
    requestText: input.requestText,
    generationId: input.generationId,
    proposalSource: input.proposalSource,
    targetGraphRevision: input.targetGraphRevision,
    attachmentIds: [...(input.attachmentIds ?? [])],
    ...(input.availabilityExplanation !== undefined ? { availabilityExplanation: input.availabilityExplanation } : {}),
    ...(input.workspaceAdmission !== undefined ? { workspaceAdmission: input.workspaceAdmission } : {}),
  };
}
