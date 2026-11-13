import { allowsControlAction, type ProductionAuthorizationFact } from './production-authorization.js';
import {
  formatApplicationSettlement,
  type ControlApplicationSettlement,
} from './control-application-settlement.js';
import { createHash } from 'node:crypto';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { ControlDecision, ControlDecisionAction, ControlEvent, ControlSnapshot } from './control-contracts.js';

export interface ControlDecisionLedgerRecord {
  id: string;
  schemaVersion: 5;
  eventId: string;
  eventType: ControlEvent['type'];
  correlationId: string;
  causationId: string | null;
  sessionId: string;
  taskId: string | null;
  subtaskId: string | null;
  attemptId: string | null;
  event: ControlEvent;
  snapshot: ControlSnapshot;
  decision: ControlDecision;
  action: ControlDecision['action']['type'];
  reason: string;
  configurationRevision: string;
  authorizedBindings: AuthorizedExecutorBinding[];
  bindingFingerprints: string[];
  createdAt: string;
}

export interface ControlDecider {
  decide(event: ControlEvent, snapshot: ControlSnapshot): ControlDecision;
}

export interface ControlRuntime {
  apply(decision: ControlDecision): Promise<ControlEvent | null>;
}

export type ControlApplicationStatus = 'pending' | 'applying' | 'applied' | 'uncertain' | 'failed';

export interface ControlDecisionApplicationRecord {
  id: string;
  decisionId: string;
  eventId: string;
  idempotencyKey: string;
  status: ControlApplicationStatus;
  applyAttempts: number;
  observationEvent: ControlEvent | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
  decision: ControlDecision;
}

export interface ControlWorkflowResult {
  decisions: ControlDecision[];
  quiescent: boolean;
  pendingRecovery: number;
}

export interface ControlRecoveryReport extends ControlWorkflowResult {
  reconciledProcessingEvents: number;
  applicationCounts: Record<ControlApplicationStatus, number>;
}

export interface ControlWorkflow {
  submit(event: ControlEvent): Promise<ControlWorkflowResult>;
  recover(): Promise<ControlRecoveryReport>;
}

/** Transactional persistence port. Implementations atomically issue a Decision and create its application. */
export type PermissionResolutionEvent = Extract<ControlEvent, { type: 'permission_resolution_received' }>;

export interface ControlWorkflowClock {
  now(): string;
}

export class ControlApplicationInterruptedError extends Error {
  constructor() {
    super('kernel application interrupted before producing an observation');
    this.name = 'ControlApplicationInterruptedError';
  }
}

/**
 * The Runtime refused the Decision before writing anything durable or starting
 * any external action. The parent application must converge: retrying the same
 * Decision cannot change the outcome, and leaving it `uncertain` strands the
 * Conversation slot (2026-10-22 review P0-3/P0-4).
 */
export class ControlApplicationRejectionError extends Error {
  constructor(
    message: string,
    readonly code = 'rejected_without_effect',
    readonly detail = message,
  ) {
    super(message);
    this.name = 'ControlApplicationRejectionError';
  }
}

/**
 * The Runtime performed the operation and journaled its outcome, which was an
 * error. The effect is settled, not unknown: the durable operation record owns
 * retry semantics, so the parent application must not stay `uncertain`.
 */
export class ControlApplicationSettledError extends Error {
  constructor(
    message: string,
    readonly code = 'operation_settled',
    readonly detail = message,
  ) {
    super(message);
    this.name = 'ControlApplicationSettledError';
  }
}

function settlementFor(error: unknown): ControlApplicationSettlement | null {
  if (error instanceof ControlApplicationRejectionError) {
    return { kind: 'rejected_without_effect', code: error.code, detail: error.detail };
  }
  if (error instanceof ControlApplicationSettledError) {
    return { kind: 'operation_settled', code: error.code, detail: error.detail };
  }
  return null;
}
