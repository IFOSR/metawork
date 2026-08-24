import { randomUUID } from 'node:crypto';
import type {
  ClaimResourceLeasesResult,
  ResourceClaim,
  ResourceLeaseRepositoryPort,
} from '../resource/index.js';
import type { ResourceLeaseRecord } from '../resource/index.js';

export class ResourceLeaseService {
  constructor(
    private readonly repository: ResourceLeaseRepositoryPort,
    private readonly leaseDurationMs = 60_000,
  ) {}

  claim(input: {
    taskId: string;
    generationId: string;
    subtaskId: string;
    attemptId: string;
    workUnitId: string;
    claims: ResourceClaim[];
    leaseToken?: string;
    now?: string;
  }): ClaimResourceLeasesResult & { leaseToken: string } {
    const now = input.now ?? new Date().toISOString();
    const leaseToken = input.leaseToken ?? `resource_token_${randomUUID()}`;
    const result = this.repository.claim({
      ...input,
      leaseToken,
      now,
      expiresAt: new Date(Date.parse(now) + this.leaseDurationMs).toISOString(),
    });
    return { ...result, leaseToken };
  }

  heartbeat(attemptId: string, leaseToken: string, now = new Date().toISOString()): number {
    return this.repository.heartbeat(
      attemptId,
      leaseToken,
      now,
      new Date(Date.parse(now) + this.leaseDurationMs).toISOString(),
    );
  }

  release(attemptId: string, leaseToken: string, now = new Date().toISOString()): number {
    return this.repository.releaseAttempt(attemptId, leaseToken, now);
  }

  releaseReconciledAttempt(attemptId: string, now = new Date().toISOString()): number {
    return this.repository.releaseReconciledAttempt(attemptId, now);
  }

  requestRevocation(input: {
    taskId: string;
    generationId: string | null;
    subtaskIds: readonly string[] | null;
    reason: string;
    now?: string;
  }): number {
    return this.repository.requestRevocation?.(
      input.taskId,
      input.generationId,
      input.subtaskIds,
      input.reason,
      input.now ?? new Date().toISOString(),
    ) ?? 0;
  }

  cancelWaits(input: {
    taskId: string;
    generationId: string | null;
    subtaskIds: readonly string[] | null;
    now?: string;
  }): number {
    return this.repository.cancelWaits?.(
      input.taskId,
      input.generationId,
      input.subtaskIds,
      input.now ?? new Date().toISOString(),
    ) ?? 0;
  }

  releaseRevokedAttempt(attemptId: string, now = new Date().toISOString()): number {
    return this.repository.releaseRevokedAttempt?.(attemptId, now) ?? 0;
  }

  findActive(now = new Date().toISOString()): ResourceLeaseRecord[] {
    return this.repository.findActive(now);
  }
}
