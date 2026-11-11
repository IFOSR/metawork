import type { ControlEvent } from '../control/control-contracts.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { RetryWakeRepo, RetryWakeRecord } from '../storage/retry-wake-repo.js';

export interface RetryWakeWorkerDeps {
  retryWakeRepo: RetryWakeRepo;
  /**
   * Applies the continuation on the Task's own control loop. The producer is
   * the wake row itself, so nothing is queued for another workflow to drain.
   */
  processTimer(event: Extract<ControlEvent, { type: 'timer_tick' }>, reason: string): Promise<void>;
  now(): string;
}

/**
 * Durable retry continuation delivery. The database row — not a process-local
 * timer and not the retired decision ledger — owns the wake. The row carries the
 * Session and the authorized binding, so the worker applies the continuation
 * directly. A `fired` row without an event is replayed on the next pass, which
 * keeps a crash between the two writes from stranding a Task.
 */
export class RetryWakeWorker {
  constructor(private readonly deps: RetryWakeWorkerDeps) {}

  async run(now = this.deps.now()): Promise<number> {
    let delivered = 0;
    for (const candidate of this.deps.retryWakeRepo.listDueOrFiredWithoutTimer(now)) {
      const wake = candidate.status === 'armed'
        ? this.deps.retryWakeRepo.claimDueWake(candidate.wakeId, now, now)
        : candidate;
      if (!wake) continue;
      if (!wake.sessionId) {
        // The Session is part of the durable wake fact. A row without it cannot
        // be delivered and must surface as an explicit recovery item.
        this.deps.retryWakeRepo.markRecoveryRequired(wake.wakeId, now);
        continue;
      }
      const sessionId = wake.sessionId;
      const timerEventId = `retry_timer_${wake.wakeId}`;
      const marked = this.deps.retryWakeRepo.markFired(
        wake.wakeId,
        timerEventId,
        now,
      );
      if (!marked && !this.deps.retryWakeRepo.findByTimerEvent(timerEventId)) continue;
      const current = this.deps.retryWakeRepo.findById(wake.wakeId);
      if (!current || current.status !== 'fired') continue;
      let event: Extract<ControlEvent, { type: 'timer_tick' }>;
      try {
        event = timerEvent(current, timerEventId, sessionId, now);
      } catch {
        this.deps.retryWakeRepo.markRecoveryRequired(current.wakeId, now);
        continue;
      }
      try {
        await this.deps.processTimer(
          event,
          `Retry Wake ${current.wakeId} delivery`,
        );
        delivered += 1;
      } catch {
        // A failed enqueue or processing attempt must leave the Wake
        // deliverable. The deterministic event id makes the next pass safe.
        this.deps.retryWakeRepo.clearTimerEvent(
          current.wakeId,
          timerEventId,
          now,
        );
      }
    }
    return delivered;
  }
}

function timerEvent(
  wake: RetryWakeRecord,
  id: string,
  sessionId: string,
  now: string,
): Extract<ControlEvent, { type: 'timer_tick' }> {
  try {
    const binding = JSON.parse(wake.authorizedBindingJson) as AuthorizedExecutorBinding;
    if (!binding.agentClassRef || !binding.harnessRef || !binding.providerRef
      || !binding.modelRef || !binding.configurationRevision) {
      throw new Error('invalid authorized binding');
    }
    return {
      schemaVersion: 5,
      configurationRevision: wake.configurationRevision,
      type: 'timer_tick',
      id,
      correlationId: wake.taskId,
      causationId: wake.sourceDecisionId,
      occurredAt: now,
      sessionId,
      taskId: wake.taskId,
      subtaskId: wake.subtaskId,
      attemptId: wake.sourceAttemptId,
      // Resource partition wakes use the Kernel's capacity timer protocol.
      wakeKind: wake.wakeKind === 'partition' ? 'capacity' : (wake.wakeKind ?? 'retry'),
      sourceDecisionId: wake.sourceDecisionId,
      scheduledFor: wake.resumeAt,
      retry: {
        wakeId: wake.wakeId,
        generationId: wake.generationId,
        configurationRevision: wake.configurationRevision,
        authorizedBinding: binding,
        bindingFingerprint: wake.bindingFingerprint,
        sourceAttemptId: wake.sourceAttemptId,
      },
    };
  } catch (error) {
    throw new Error(
      `Retry Wake ${wake.wakeId} has invalid authorized binding: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
