import type { Subtask, WorkUnit } from '../core/types.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { generateInteractionId } from '../utils/id.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { truncateText } from '../utils/truncate-text.js';

export interface WorkUnitClaim {
  workUnit: WorkUnit;
  attemptId: string;
  startAttempt(): void;
  release(): void;
  markRunning(): void;
  heartbeat(): void;
  markWaiting(message?: string): void;
  markFailed(message?: string): void;
}

export class WorkUnitClaimService {
  constructor(
    private readonly workUnitRepo: WorkUnitRepo,
    private readonly leaseMs = 60_000,
    private readonly probeExecutor: (
      agentClassName: string,
      mode: 'claim' | 'capacity',
    ) => Promise<boolean> = async () => false,
  ) {}

  async claim(input: {
    taskId: string;
    subtask: Pick<Subtask, 'id' | 'preferredAgentClassList'>;
    attemptId: string;
  }): Promise<WorkUnitClaim | null> {
    let workUnit = this.workUnitRepo.findIdleByKind(
      'executor',
      input.subtask.preferredAgentClassList,
    );
    if (!workUnit) {
      for (const agentClassName of input.subtask.preferredAgentClassList) {
        workUnit = await this.provisionExecutor(agentClassName, 'claim');
        if (workUnit) break;
      }
    }
    if (!workUnit) return null;

    const now = new Date();
    const heartbeatAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
    this.workUnitRepo.updateState(workUnit.id, 'claimed', {
      claimedTaskId: input.taskId,
      claimedSubtaskId: input.subtask.id,
      claimedAttemptId: input.attemptId,
      heartbeatAt,
      leaseExpiresAt,
    });
    this.recordEvent(workUnit.id, input.taskId, input.subtask.id, input.attemptId, 'claimed', 'claimed');

    return {
      workUnit: this.workUnitRepo.findById(workUnit.id)!,
      attemptId: input.attemptId,
      startAttempt: () => this.recordEvent(
        workUnit!.id,
        input.taskId,
        input.subtask.id,
        input.attemptId,
        'attempt_started',
        'claimed',
      ),
      release: () => this.release(
        workUnit!.id,
        input.taskId,
        input.subtask.id,
        input.attemptId,
      ),
      markRunning: () => this.mark(workUnit!.id, input.taskId, input.subtask.id, input.attemptId, 'running'),
      heartbeat: () => this.mark(workUnit!.id, input.taskId, input.subtask.id, input.attemptId, 'running'),
      markWaiting: (message = 'work unit waiting') => this.mark(workUnit!.id, input.taskId, input.subtask.id, input.attemptId, 'waiting', message),
      markFailed: (message = 'work unit failed') => this.mark(workUnit!.id, input.taskId, input.subtask.id, input.attemptId, 'failed', message),
    };
  }

  async probe(agentClassName: string): Promise<boolean> {
    if (this.workUnitRepo.findIdleByKind('executor', [agentClassName])) return true;
    return Boolean(await this.provisionExecutor(agentClassName, 'capacity'));
  }

  isClaimCurrent(workUnitId: string, attemptId: string, requiredState?: WorkUnit['state']): boolean {
    const workUnit = this.workUnitRepo.findById(workUnitId);
    return Boolean(
      workUnit
      && workUnit.claimedAttemptId === attemptId
      && (!requiredState || workUnit.state === requiredState),
    );
  }

  sweepExpired(now = new Date()): WorkUnit[] {
    const lost = this.workUnitRepo.markHeartbeatLost(now.toISOString());
    for (const workUnit of lost) {
      this.recordEvent(workUnit.id, workUnit.claimedTaskId, workUnit.claimedSubtaskId, workUnit.claimedAttemptId, 'heartbeat_lost', 'heartbeat_lost');
      this.workUnitRepo.updateState(workUnit.id, 'heartbeat_lost', {
        claimedTaskId: null,
        claimedSubtaskId: null,
        claimedAttemptId: null,
        leaseExpiresAt: null,
      });
      this.recordEvent(workUnit.id, workUnit.claimedTaskId, workUnit.claimedSubtaskId, workUnit.claimedAttemptId, 'released', 'heartbeat_lost');
    }
    return lost;
  }

  releaseOrphanedAttempt(input: {
    workUnitId: string;
    taskId: string;
    subtaskId: string;
    attemptId: string;
  }): void {
    this.release(input.workUnitId, input.taskId, input.subtaskId, input.attemptId);
  }

  hasClaimedByTask(taskId: string): boolean {
    return this.workUnitRepo.findAll().some(workUnit =>
      workUnit.claimedTaskId === taskId
      && ['claimed', 'running', 'waiting'].includes(workUnit.state)
    );
  }

  listOrphanedClaims(): WorkUnit[] {
    return this.workUnitRepo.findAll().filter(workUnit =>
      ['claimed', 'running', 'waiting'].includes(workUnit.state)
      && workUnit.claimedAttemptId !== null
    );
  }

  releaseReconciledClaim(input: {
    workUnitId: string;
    taskId: string;
    subtaskId: string;
    attemptId: string;
  }): void {
    const existing = this.workUnitRepo.findById(input.workUnitId);
    if (
      !existing
      || existing.claimedTaskId !== input.taskId
      || existing.claimedSubtaskId !== input.subtaskId
      || existing.claimedAttemptId !== input.attemptId
    ) {
      this.releaseOrphanedAttempt(input);
      return;
    }
    this.workUnitRepo.updateState(existing.id, 'heartbeat_lost', {
      claimedTaskId: input.taskId,
      claimedSubtaskId: input.subtaskId,
      claimedAttemptId: input.attemptId,
      leaseExpiresAt: null,
    });
    this.recordEvent(
      existing.id,
      input.taskId,
      input.subtaskId,
      input.attemptId,
      'heartbeat_lost',
      'heartbeat_lost',
      'startup reconciled orphaned WorkUnit claim after terminal facts were sealed',
    );
    this.releaseOrphanedAttempt(input);
  }

  private async provisionExecutor(
    agentClassName: string,
    mode: 'claim' | 'capacity',
  ): Promise<WorkUnit | null> {
    const now = new Date().toISOString();
    const id = `executor-${sanitizeId(agentClassName)}-${generateInteractionId()}`;
    this.workUnitRepo.upsert({
      id,
      agentClassName,
      agentClassKind: 'executor',
      state: 'starting',
      claimedTaskId: null,
      claimedSubtaskId: null,
      claimedAttemptId: null,
      heartbeatAt: now,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.recordEvent(id, null, null, null, 'probe_started', 'starting');
    let available = false;
    let failureReason = `executor probe returned unavailable: ${agentClassName}`;
    try {
      available = await this.probeExecutor(agentClassName, mode);
    } catch (error) {
      available = false;
      const detail = error instanceof Error ? error.message : String(error);
      failureReason = truncateText(
        redactSensitiveText(`executor probe failed: ${agentClassName}: ${detail}`),
        800,
      );
    }
    if (!available) {
      this.workUnitRepo.updateState(id, 'failed', { heartbeatAt: new Date().toISOString() });
      this.recordEvent(id, null, null, null, 'probe_failed', 'failed', failureReason);
      return null;
    }
    this.workUnitRepo.updateState(id, 'idle', { heartbeatAt: new Date().toISOString() });
    this.recordEvent(id, null, null, null, 'probe_succeeded', 'idle', `executor probe succeeded: ${agentClassName}`);
    return this.workUnitRepo.findById(id);
  }

  private mark(
    workUnitId: string,
    taskId: string,
    subtaskId: string,
    attemptId: string,
    state: 'running' | 'waiting' | 'failed',
    message: string = state,
  ): void {
    const now = new Date();
    this.workUnitRepo.updateState(workUnitId, state, {
      claimedTaskId: taskId,
      claimedSubtaskId: subtaskId,
      claimedAttemptId: attemptId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    this.recordEvent(workUnitId, taskId, subtaskId, attemptId, state, state, message);
  }

  private release(workUnitId: string, taskId: string, subtaskId: string, attemptId: string): void {
    const existing = this.workUnitRepo.findById(workUnitId);
    if (!existing) return;
    if (existing.claimedAttemptId !== attemptId) {
      this.recordEvent(
        workUnitId,
        taskId,
        subtaskId,
        attemptId,
        'release_skipped_stale',
        existing.state,
        `release skipped because WorkUnit is no longer claimed by attempt ${attemptId}`,
      );
      return;
    }
    const claimedTaskId = existing.claimedTaskId;
    const claimedSubtaskId = existing.claimedSubtaskId;
    const claimedAttemptId = existing.claimedAttemptId;
    const releaseState = existing.state === 'failed' || existing.state === 'heartbeat_lost'
      ? existing.state
      : 'idle';
    this.workUnitRepo.updateState(workUnitId, releaseState, {
      claimedTaskId: null,
      claimedSubtaskId: null,
      claimedAttemptId: null,
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: null,
    });
    this.recordEvent(workUnitId, claimedTaskId, claimedSubtaskId, claimedAttemptId, 'released', releaseState);
  }

  private recordEvent(
    workUnitId: string,
    taskId: string | null,
    subtaskId: string | null,
    attemptId: string | null,
    eventType: string,
    state: WorkUnit['state'],
    message = eventType,
  ): void {
    this.workUnitRepo.insertEvent({
      id: `wue_${generateInteractionId()}`,
      workUnitId,
      taskId,
      subtaskId,
      attemptId,
      eventType,
      state,
      message,
      payload: {},
      createdAt: new Date().toISOString(),
    });
  }
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'executor';
}
