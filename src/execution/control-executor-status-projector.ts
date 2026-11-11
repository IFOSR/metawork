import {
  projectExecutionOutcome,
  projectRecoveryCheck,
  type ExecutorRecoveryRefreshTrigger,
} from '../control/executor-status-projection.js';
import type {
  ControlExecutorStatusRepo,
  RevisionedControlExecutorStatusProjection,
} from '../storage/executor-status-repo.js';
import type { ControlFailure } from '../control/control-failure.js';

/** Execution-side projector that persists dynamic AgentClass health facts. */
export class ControlExecutorStatusProjector {
  constructor(private readonly repo: ControlExecutorStatusRepo) {}

  recordExecutionOutcome(input: {
    agentClassName: string;
    configurationRevision: string;
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    failure?: ControlFailure | null;
    completedAt?: string;
  }): RevisionedControlExecutorStatusProjection {
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
    failure?: ControlFailure | null;
  }): RevisionedControlExecutorStatusProjection | null {
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

  list(configurationRevision: string): RevisionedControlExecutorStatusProjection[] {
    return this.repo.list(configurationRevision);
  }
}
