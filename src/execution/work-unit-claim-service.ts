import type { Subtask, WorkUnit } from '../core/types.js';
import { WorkUnitRepo } from '../storage/work-unit-repo.js';
import { generateInteractionId } from '../utils/id.js';

export interface WorkUnitClaim {
  workUnit: WorkUnit;
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
    private readonly probeExecutor: (agentClassName: string) => Promise<boolean> = async () => false,
  ) {}

  async claim(input: {
    taskId: string;
    subtask: Pick<Subtask, 'id' | 'preferredAgentClassList'>;
  }): Promise<WorkUnitClaim | null> {
    let workUnit = this.workUnitRepo.findIdleByKind(
      'executor',
      input.subtask.preferredAgentClassList,
    );
    if (!workUnit) {
      for (const agentClassName of input.subtask.preferredAgentClassList) {
        workUnit = await this.provisionExecutor(agentClassName);
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
      heartbeatAt,
      leaseExpiresAt,
    });
    this.recordEvent(workUnit.id, input.taskId, input.subtask.id, 'claimed', 'claimed');

    return {
      workUnit: this.workUnitRepo.findById(workUnit.id)!,
      release: () => this.release(workUnit!.id),
      markRunning: () => this.mark(workUnit!.id, input.taskId, input.subtask.id, 'running'),
      heartbeat: () => this.mark(workUnit!.id, input.taskId, input.subtask.id, 'running'),
      markWaiting: (message = 'work unit waiting') => this.mark(workUnit!.id, input.taskId, input.subtask.id, 'waiting', message),
      markFailed: (message = 'work unit failed') => this.mark(workUnit!.id, input.taskId, input.subtask.id, 'failed', message),
    };
  }

  sweepExpired(now = new Date()): WorkUnit[] {
    const lost = this.workUnitRepo.markHeartbeatLost(now.toISOString());
    for (const workUnit of lost) {
      this.recordEvent(workUnit.id, workUnit.claimedTaskId, workUnit.claimedSubtaskId, 'heartbeat_lost', 'heartbeat_lost');
    }
    return lost;
  }

  private async provisionExecutor(agentClassName: string): Promise<WorkUnit | null> {
    const now = new Date().toISOString();
    const id = `executor-${sanitizeId(agentClassName)}-${generateInteractionId()}`;
    this.workUnitRepo.upsert({
      id,
      agentClassName,
      agentClassKind: 'executor',
      state: 'starting',
      claimedTaskId: null,
      claimedSubtaskId: null,
      heartbeatAt: now,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.recordEvent(id, null, null, 'probe_started', 'starting');
    let available = false;
    try {
      available = await this.probeExecutor(agentClassName);
    } catch {
      available = false;
    }
    if (!available) {
      this.workUnitRepo.updateState(id, 'failed', { heartbeatAt: new Date().toISOString() });
      this.recordEvent(id, null, null, 'probe_failed', 'failed', `executor probe failed: ${agentClassName}`);
      return null;
    }
    this.workUnitRepo.updateState(id, 'idle', { heartbeatAt: new Date().toISOString() });
    this.recordEvent(id, null, null, 'probe_succeeded', 'idle', `executor probe succeeded: ${agentClassName}`);
    return this.workUnitRepo.findById(id);
  }

  private mark(
    workUnitId: string,
    taskId: string,
    subtaskId: string,
    state: 'running' | 'waiting' | 'failed',
    message: string = state,
  ): void {
    const now = new Date();
    this.workUnitRepo.updateState(workUnitId, state, {
      claimedTaskId: taskId,
      claimedSubtaskId: subtaskId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
    this.recordEvent(workUnitId, taskId, subtaskId, state, state, message);
  }

  private release(workUnitId: string): void {
    const existing = this.workUnitRepo.findById(workUnitId);
    if (!existing || existing.state === 'failed' || existing.state === 'heartbeat_lost') return;
    const claimedTaskId = existing.claimedTaskId;
    const claimedSubtaskId = existing.claimedSubtaskId;
    this.workUnitRepo.updateState(workUnitId, 'idle', {
      claimedTaskId: null,
      claimedSubtaskId: null,
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: null,
    });
    this.recordEvent(workUnitId, claimedTaskId, claimedSubtaskId, 'released', 'idle');
  }

  private recordEvent(
    workUnitId: string,
    taskId: string | null,
    subtaskId: string | null,
    eventType: string,
    state: WorkUnit['state'],
    message = eventType,
  ): void {
    this.workUnitRepo.insertEvent({
      id: `wue_${generateInteractionId()}`,
      workUnitId,
      taskId,
      subtaskId,
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
