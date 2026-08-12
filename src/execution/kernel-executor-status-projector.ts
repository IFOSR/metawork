import {
  projectExecutionOutcome,
  projectRecoveryCheck,
  type ExecutorRecoveryRefreshTrigger,
} from '../kernel/executor-status-projection.js';
import type {
  KernelExecutorStatusRepo,
  RevisionedKernelExecutorStatusProjection,
} from '../storage/kernel-executor-status-repo.js';
import type { KernelFailure } from '../kernel/kernel-failure.js';

/** Execution-side projector that persists dynamic AgentClass health facts. */
export class KernelExecutorStatusProjector {
  constructor(private readonly repo: KernelExecutorStatusRepo) {}

  recordExecutionOutcome(input: {
    agentClassName: string;
    configurationRevision: string;
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    failure?: KernelFailure | null;
    completedAt?: string;
  }): RevisionedKernelExecutorStatusProjection {
    const projection = {
      ...projectExecutionOutcome(this.repo.findByAgentClassName(
        input.agentClassName,
        input.configurationRevision,
      ), {
        ...input,
        completedAt: input.completedAt ?? new Date().toISOString(),
      }),
      configurationRevision: input.configurationRevision,
    };
    this.repo.upsert(projection);
    return projection;
  }

  recordRecoveryCheck(input: {
    agentClassName: string;
    configurationRevision: string;
    checkId: string;
    trigger: ExecutorRecoveryRefreshTrigger;
    startedAt: string;
    completedAt: string;
    outcome: 'recovered' | 'still_error' | 'probe_timeout';
    failure?: KernelFailure | null;
  }): RevisionedKernelExecutorStatusProjection | null {
    const current = this.repo.findByAgentClassName(
      input.agentClassName,
      input.configurationRevision,
    );
    if (!current || current.classHealth === 'disabled') return current;
    const projection = {
      ...projectRecoveryCheck(current, {
        ...input,
        failure: input.failure ?? null,
      }),
      configurationRevision: input.configurationRevision,
    };
    this.repo.upsert(projection);
    return projection;
  }

  list(configurationRevision: string): RevisionedKernelExecutorStatusProjection[] {
    return this.repo.list(configurationRevision);
  }
}
