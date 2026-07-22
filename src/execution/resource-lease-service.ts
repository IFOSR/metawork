import { randomUUID } from 'node:crypto';
import type {
  ClaimResourceLeasesResult,
  ResourceClaim,
  ResourceLeaseRepositoryPort,
} from '../resource/index.js';

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
}
