import type { KernelFailure } from '../core/kernel-failure.js';
import type {
  ExecutorRecoveryRefreshTrigger,
  KernelExecutorStatusProjection,
} from '../kernel/executor-status-projection.js';
import type { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { generateInteractionId } from '../utils/id.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import type { ExecutorProbeResult } from '../executor/adapter.js';
import type { KernelExecutorStatusProjector } from './kernel-executor-status-projector.js';

export interface ExecutorRecoveryRefreshReport {
  trigger: ExecutorRecoveryRefreshTrigger;
  checked: string[];
  recovered: string[];
  stillError: string[];
  skipped: string[];
}

export interface ExecutorRecoveryRefreshServiceDeps {
  statusRepo: KernelExecutorStatusRepo;
  statusProjector: KernelExecutorStatusProjector;
  probe(agentClassName: string, previousFailure: KernelFailure | null): Promise<ExecutorProbeResult>;
  onRecovered?(agentClassName: string, checkId: string): Promise<void> | void;
  timeoutMs?: number;
  now?(): Date;
}

interface CheckResult {
  agentClassName: string;
  outcome: 'recovered' | 'still_error' | 'probe_timeout';
}

export class ExecutorRecoveryRefreshService {
  private readonly inFlight = new Map<string, Promise<CheckResult>>();

  constructor(private readonly deps: ExecutorRecoveryRefreshServiceDeps) {}

  async refresh(input: {
    trigger: ExecutorRecoveryRefreshTrigger;
    agentClassNames?: string[];
  }): Promise<ExecutorRecoveryRefreshReport> {
    const requested = input.agentClassNames ? new Set(input.agentClassNames) : null;
    const projections = this.deps.statusRepo.list();
    const targets = projections.filter(projection =>
      projection.classHealth === 'error'
      && (!requested || requested.has(projection.agentClassName))
    );
    const skipped = projections
      .filter(projection =>
        (!requested || requested.has(projection.agentClassName))
        && projection.classHealth !== 'error'
      )
      .map(projection => projection.agentClassName);
    if (requested) {
      for (const name of requested) {
        if (!projections.some(projection => projection.agentClassName === name)) skipped.push(name);
      }
    }

    const results = await Promise.all(targets.map(projection =>
      this.refreshOne(projection, input.trigger)
    ));
    return {
      trigger: input.trigger,
      checked: targets.map(target => target.agentClassName),
      recovered: results.filter(result => result.outcome === 'recovered').map(result => result.agentClassName),
      stillError: results.filter(result => result.outcome !== 'recovered').map(result => result.agentClassName),
      skipped: [...new Set(skipped)],
    };
  }

  private refreshOne(
    projection: KernelExecutorStatusProjection,
    trigger: ExecutorRecoveryRefreshTrigger,
  ): Promise<CheckResult> {
    const existing = this.inFlight.get(projection.agentClassName);
    if (existing) return existing;
    const promise = this.performCheck(projection, trigger)
      .finally(() => this.inFlight.delete(projection.agentClassName));
    this.inFlight.set(projection.agentClassName, promise);
    return promise;
  }

  private async performCheck(
    projection: KernelExecutorStatusProjection,
    trigger: ExecutorRecoveryRefreshTrigger,
  ): Promise<CheckResult> {
    const startedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const checkId = `executor_recovery_${generateInteractionId()}`;
    const timeoutMs = this.deps.timeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let outcome: CheckResult['outcome'] = 'still_error';
    let failure: KernelFailure | null = null;
    try {
      const probe = await Promise.race([
        this.deps.probe(
          projection.agentClassName,
          projection.recentRecoveryChecks[0]?.failure
            ?? projection.recentAttempts[0]?.failure
            ?? null,
        ),
        new Promise<ExecutorProbeResult>((_, reject) => {
          timer = setTimeout(() => reject(new ExecutorProbeTimeoutError()), timeoutMs);
          timer.unref?.();
        }),
      ]);
      outcome = probe.available ? 'recovered' : 'still_error';
      failure = probe.failure ? redactFailure(probe.failure) : null;
    } catch (error) {
      const timeout = error instanceof ExecutorProbeTimeoutError;
      outcome = timeout ? 'probe_timeout' : 'still_error';
      failure = {
        kind: timeout ? 'timeout' : 'adapter',
        scope: 'agent_class',
        code: timeout ? 'probe_timeout' : 'recovery_probe_failed',
        summary: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const completedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const updated = this.deps.statusProjector.recordRecoveryCheck({
      agentClassName: projection.agentClassName,
      checkId,
      trigger,
      startedAt,
      completedAt,
      outcome,
      failure,
    });
    if (outcome === 'recovered' && updated?.classHealth === 'healthy') {
      await this.deps.onRecovered?.(projection.agentClassName, checkId);
    }
    return { agentClassName: projection.agentClassName, outcome };
  }
}

class ExecutorProbeTimeoutError extends Error {
  constructor() {
    super('Executor recovery probe exceeded 30 seconds');
  }
}

function redactFailure(failure: KernelFailure): KernelFailure {
  return {
    ...failure,
    summary: redactSensitiveText(failure.summary),
  };
}
