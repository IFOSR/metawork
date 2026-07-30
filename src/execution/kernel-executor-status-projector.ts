import {
  projectExecutionOutcome,
  projectRecoveryCheck,
  type ExecutorRecoveryRefreshTrigger,
  type KernelExecutorStatusProjection,
} from '../kernel/executor-status-projection.js';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import type { KernelFailure } from '../kernel/kernel-failure.js';

/** Execution-side projector that persists dynamic AgentClass health facts. */
export class KernelExecutorStatusProjector {
  constructor(private readonly repo: KernelExecutorStatusRepo) {}

  recordExecutionOutcome(input: {
    agentClassName: string;
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    failure?: KernelFailure | null;
    completedAt?: string;
  }): KernelExecutorStatusProjection {
    const projection = projectExecutionOutcome(this.repo.findByAgentClassName(input.agentClassName), {
      ...input,
      completedAt: input.completedAt ?? new Date().toISOString(),
    });
    this.repo.upsert(projection);
    return projection;
  }

  recordRecoveryCheck(input: {
    agentClassName: string;
    checkId: string;
    trigger: ExecutorRecoveryRefreshTrigger;
    startedAt: string;
    completedAt: string;
    outcome: 'recovered' | 'still_error' | 'probe_timeout';
    failure?: KernelFailure | null;
  }): KernelExecutorStatusProjection | null {
    const current = this.repo.findByAgentClassName(input.agentClassName);
    if (!current || current.classHealth === 'disabled') return current;
    const projection = projectRecoveryCheck(current, {
      ...input,
      failure: input.failure ?? null,
    });
    this.repo.upsert(projection);
    return projection;
  }

  list(): KernelExecutorStatusProjection[] {
    return this.repo.list();
  }
}
