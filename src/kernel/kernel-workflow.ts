import type { KernelDecision, KernelDecisionAction, KernelEvent, KernelSnapshot } from './control-kernel.js';

export interface KernelDecisionLedgerRecord {
  id: string;
  schemaVersion: 4;
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

export type KernelApplicationStatus = 'pending' | 'applying' | 'applied' | 'uncertain' | 'failed';

export interface KernelDecisionApplicationRecord {
  id: string;
  decisionId: string;
  eventId: string;
  idempotencyKey: string;
  status: KernelApplicationStatus;
  applyAttempts: number;
  observationEvent: KernelEvent | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
  decision: KernelDecision;
}

export interface KernelWorkflowResult {
  decisions: KernelDecision[];
  quiescent: boolean;
  pendingRecovery: number;
}

export interface KernelRecoveryReport extends KernelWorkflowResult {
  reconciledProcessingEvents: number;
  applicationCounts: Record<KernelApplicationStatus, number>;
}

export interface KernelWorkflow {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
  recover(): Promise<KernelRecoveryReport>;
}

/** Transactional persistence port. Implementations atomically issue a Decision and create its application. */
export interface KernelWorkflowStore {
  enqueue(event: KernelEvent, availableAt?: string): boolean;
  claimNext(now: string, eventTypes?: KernelEvent['type'][], taskId?: string): KernelEvent | null;
  issue(eventId: string, record: KernelDecisionLedgerRecord): KernelDecisionApplicationRecord;
  listRecoverableApplications(actions?: KernelDecisionAction['type'][], taskId?: string): KernelDecisionApplicationRecord[];
  markApplying(decisionId: string, now: string): KernelDecisionApplicationRecord;
  markApplied(decisionId: string, observation: KernelEvent | null, now: string): void;
  markApplicationFailed(
    decisionId: string,
    status: Extract<KernelApplicationStatus, 'uncertain' | 'failed'>,
    errorSummary: string,
    now: string,
  ): void;
  reconcileProcessing(): number;
  countByApplicationStatus(): Record<KernelApplicationStatus, number>;
}

export interface KernelWorkflowClock {
  now(): string;
}

export interface DurableKernelWorkflowDeps {
  kernel: KernelDecider;
  buildSnapshot(event: KernelEvent): KernelSnapshot;
  store: KernelWorkflowStore;
  runtime: KernelRuntime;
  clock: KernelWorkflowClock;
  acceptedEventTypes?: KernelEvent['type'][];
  acceptedActions?: KernelDecisionAction['type'][];
  taskId?: string;
}

const MAX_DECISIONS_PER_DRAIN = 100;

/**
 * Durable Application module. It owns sequencing and crash recovery, while the
 * pure ControlKernel owns policy and Runtime owns idempotent side effects.
 */
export class DurableKernelWorkflow implements KernelWorkflow {
  private draining: Promise<KernelWorkflowResult> | null = null;

  constructor(private readonly deps: DurableKernelWorkflowDeps) {}

  async submit(event: KernelEvent): Promise<KernelWorkflowResult> {
    // submit() is called after the trigger boundary has been reached. Delayed
    // observations retain their future availability when markApplied inserts them.
    this.deps.store.enqueue(event, this.deps.clock.now());
    return this.drainSerially();
  }

  async recover(): Promise<KernelRecoveryReport> {
    const reconciledProcessingEvents = this.deps.store.reconcileProcessing();
    const result = await this.drainSerially();
    return {
      ...result,
      reconciledProcessingEvents,
      applicationCounts: this.deps.store.countByApplicationStatus(),
    };
  }

  private drainSerially(): Promise<KernelWorkflowResult> {
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drain(): Promise<KernelWorkflowResult> {
    const decisions: KernelDecision[] = [];
    let handled = 0;
    while (handled < MAX_DECISIONS_PER_DRAIN) {
      const application = this.deps.store.listRecoverableApplications(
        this.deps.acceptedActions, this.deps.taskId,
      )[0];
      if (application) {
        decisions.push(application.decision);
        handled += 1;
        const continued = await this.apply(application);
        if (!continued) break;
        continue;
      }

      const event = this.deps.store.claimNext(
        this.deps.clock.now(), this.deps.acceptedEventTypes, this.deps.taskId,
      );
      if (!event) break;
      const snapshot = this.deps.buildSnapshot(event);
      const nextDecision = this.deps.kernel.decide(event, snapshot);
      this.deps.store.issue(event.id, ledgerRecord(event, snapshot, nextDecision));
    }
    if (handled >= MAX_DECISIONS_PER_DRAIN) {
      throw new Error('Kernel workflow did not reach quiescence');
    }
    const counts = this.deps.store.countByApplicationStatus();
    return {
      decisions,
      quiescent: counts.pending === 0 && counts.applying === 0,
      pendingRecovery: counts.uncertain + counts.failed,
    };
  }

  private async apply(application: KernelDecisionApplicationRecord): Promise<boolean> {
    const applying = this.deps.store.markApplying(application.decisionId, this.deps.clock.now());
    try {
      const observation = await this.deps.runtime.apply(applying.decision);
      this.deps.store.markApplied(applying.decisionId, observation, this.deps.clock.now());
      return true;
    } catch (error) {
      this.deps.store.markApplicationFailed(
        applying.decisionId,
        'uncertain',
        boundedError(error),
        this.deps.clock.now(),
      );
      return false;
    }
  }
}

function ledgerRecord(
  event: KernelEvent,
  snapshot: KernelSnapshot,
  nextDecision: KernelDecision,
): KernelDecisionLedgerRecord {
  return {
    id: nextDecision.id,
    schemaVersion: 4,
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
  };
}

function decisionTaskId(decision: KernelDecision): string | null {
  return 'taskId' in decision.action ? decision.action.taskId : null;
}

function decisionSubtaskId(decision: KernelDecision): string | null {
  return 'subtaskId' in decision.action ? decision.action.subtaskId : null;
}

function decisionAttemptId(decision: KernelDecision): string | null {
  return decision.action.type === 'dispatch_batch' && decision.action.items.length === 1
    ? decision.action.items[0]!.attemptId
    : null;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 320);
}
