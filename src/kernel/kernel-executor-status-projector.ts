import { projectExecutionOutcome, type KernelExecutorStatusProjection } from './executor-status-projection.js';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';

export class KernelExecutorStatusProjector {
  constructor(private readonly repo: KernelExecutorStatusRepo) {}

  recordExecutionOutcome(input: {
    agentClassName: string;
    outcome: 'succeeded' | 'failed';
    error?: string | null;
    completedAt?: string;
  }): KernelExecutorStatusProjection {
    const projection = projectExecutionOutcome(this.repo.findByAgentClassName(input.agentClassName), {
      ...input,
      completedAt: input.completedAt ?? new Date().toISOString(),
    });
    this.repo.upsert(projection);
    return projection;
  }
}
