import { projectExecutionOutcome, type KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';

/** Execution-side projector that persists dynamic AgentClass health facts. */
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

  list(): KernelExecutorStatusProjection[] {
    return this.repo.list();
  }
}
