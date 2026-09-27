import type { KernelEvent } from '../kernel/control-kernel.js';
import type { AuthorizedExecutorBinding } from '../core/authorized-executor-binding.js';
import type { KernelWorkflowStore } from '../kernel/kernel-workflow.js';
import type { RetryWakeRepo, RetryWakeRecord } from '../storage/retry-wake-repo.js';

export interface RetryWakeWorkerDeps {
  retryWakeRepo: RetryWakeRepo;
  kernelWorkflowStore: Pick<KernelWorkflowStore, 'enqueue' | 'isDecisionApplied'>;
  findSessionId(sourceDecisionId: string, taskId: string): string | null;
  processTimer(event: Extract<KernelEvent, { type: 'timer_tick' }>, reason: string): Promise<void>;
  now(): string;
}

/**
 * Durable retry continuation delivery. The database row, rather than a
 * process-local timer, owns the wake. A fired row without an event is replayed
 * on the next pass, so a crash between the two writes cannot strand a Task.
 */
export class RetryWakeWorker {
  constructor(private readonly deps: RetryWakeWorkerDeps) {}

  async run(now = this.deps.now()): Promise<number> {
    let delivered = 0;
    for (const candidate of this.deps.retryWakeRepo.listDueOrFiredWithoutTimer(now)) {
      // The Wake is a continuation of the wait_for_retry Decision. Until the
      // parent application is durably applied, delivering its Timer would let
      // the continuation race a stale Kernel snapshot.
      if (!this.deps.kernelWorkflowStore.isDecisionApplied(candidate.sourceDecisionId)) {
        continue;
      }
      const wake = candidate.status === 'armed'
        ? this.deps.retryWakeRepo.claimDueWake(candidate.wakeId, now, now)
        : candidate;
      if (!wake) continue;
      if (!this.deps.kernelWorkflowStore.isDecisionApplied(wake.sourceDecisionId)) {
        continue;
      }
      const sessionId = this.deps.findSessionId(wake.sourceDecisionId, wake.taskId);
      if (!sessionId) {
        this.deps.retryWakeRepo.markRecoveryRequired(wake.wakeId, now);
        continue;
      }
      const timerEventId = `retry_timer_${wake.wakeId}`;
      const marked = this.deps.retryWakeRepo.markFired(
        wake.wakeId,
        timerEventId,
        now,
      );
      if (!marked && !this.deps.retryWakeRepo.findByTimerEvent(timerEventId)) continue;
      const current = this.deps.retryWakeRepo.findById(wake.wakeId);
      if (!current || current.status !== 'fired') continue;
      let event: Extract<KernelEvent, { type: 'timer_tick' }>;
      try {
        event = timerEvent(current, timerEventId, sessionId, now);
      } catch {
        this.deps.retryWakeRepo.markRecoveryRequired(current.wakeId, now);
        continue;
      }
      try {
        this.deps.kernelWorkflowStore.enqueue(event, now);
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
): Extract<KernelEvent, { type: 'timer_tick' }> {
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
      wakeKind: 'retry',
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
