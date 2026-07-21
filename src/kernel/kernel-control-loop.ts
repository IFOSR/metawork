import type { KernelDecision, KernelEvent, KernelSnapshot } from './control-kernel.js';

export interface KernelDecisionLedgerRecord {
  id: string;
  schemaVersion: 1 | 2;
  eventId: string;
  eventType: KernelEvent['type'];
  correlationId: string;
  causationId: string | null;
  sessionId: string;
  taskId: string | null;
  subtaskId: string | null;
  attemptId: string | null;
  event: KernelEvent;
  snapshot: KernelSnapshot;
  decision: KernelDecision;
  action: KernelDecision['action']['type'];
  reason: string;
  createdAt: string;
}

export interface KernelDecider {
  decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision;
}

export interface KernelRuntime {
  apply(decision: KernelDecision): Promise<KernelEvent | null>;
}

export interface KernelDecisionLedger {
  issue(record: KernelDecisionLedgerRecord): boolean;
}

export interface KernelControlLoopDeps {
  kernel: KernelDecider;
  buildSnapshot(event: KernelEvent): KernelSnapshot;
  ledger: KernelDecisionLedger;
  runtime: KernelRuntime;
}

const MAX_SYNCHRONOUS_DECISIONS = 100;

/** Deep Application module for ledger-first decide/apply/observe execution. */
export class KernelControlLoop {
  constructor(private readonly deps: KernelControlLoopDeps) {}

  async run(initialEvent: KernelEvent): Promise<KernelDecision[]> {
    const decisions: KernelDecision[] = [];
    let event: KernelEvent | null = initialEvent;
    while (event) {
      if (decisions.length >= MAX_SYNCHRONOUS_DECISIONS) {
        throw new Error('Kernel control loop did not reach quiescence');
      }
      const snapshot = this.deps.buildSnapshot(event);
      const nextDecision = this.deps.kernel.decide(event, snapshot);
      const issued = this.deps.ledger.issue({
        id: nextDecision.id,
        schemaVersion: 2,
        eventId: event.id,
        eventType: event.type,
        correlationId: event.correlationId,
        causationId: event.causationId,
        sessionId: event.sessionId,
        taskId: event.taskId ?? decisionTaskId(nextDecision),
        subtaskId: event.subtaskId ?? decisionSubtaskId(nextDecision),
        attemptId: event.attemptId ?? decisionAttemptId(nextDecision),
        event,
        snapshot,
        decision: nextDecision,
        action: nextDecision.action.type,
        reason: nextDecision.reason,
        createdAt: event.occurredAt,
      });
      if (!issued) break;
      decisions.push(nextDecision);
      event = await this.deps.runtime.apply(nextDecision);
    }
    return decisions;
  }
}

function decisionTaskId(decision: KernelDecision): string | null {
  return 'taskId' in decision.action ? decision.action.taskId : null;
}

function decisionSubtaskId(decision: KernelDecision): string | null {
  return 'subtaskId' in decision.action ? decision.action.subtaskId : null;
}

function decisionAttemptId(decision: KernelDecision): string | null {
  return decision.action.type === 'dispatch_attempt' ? decision.action.attemptId : null;
}
