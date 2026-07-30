import { describe, expect, it } from 'vitest';
import { ExecutorRecoveryRefreshService } from '../../src/execution/executor-recovery-refresh-service.js';
import { projectRecoveryCheck, type KernelExecutorStatusProjection } from '../../src/kernel/executor-status-projection.js';
import type { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';
import type { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';

function projection(
  agentClassName: string,
  classHealth: KernelExecutorStatusProjection['classHealth'],
): KernelExecutorStatusProjection {
  return {
    agentClassName,
    classHealth,
    recentAttempts: [],
    recentRecoveryChecks: [],
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

function harness(initial: KernelExecutorStatusProjection[]) {
  const values = new Map(initial.map(item => [item.agentClassName, item]));
  const repo = {
    list: () => [...values.values()],
    findByAgentClassName: (name: string) => values.get(name) ?? null,
    upsert: (item: KernelExecutorStatusProjection) => void values.set(item.agentClassName, item),
  } as unknown as KernelExecutorStatusRepo;
  const projector = {
    recordRecoveryCheck: (input: Parameters<KernelExecutorStatusProjector['recordRecoveryCheck']>[0]) => {
      const current = values.get(input.agentClassName);
      if (!current || current.classHealth === 'disabled') return current ?? null;
      const next = projectRecoveryCheck(current, { ...input, failure: input.failure ?? null });
      values.set(input.agentClassName, next);
      return next;
    },
  } as KernelExecutorStatusProjector;
  return { values, repo, projector };
}

describe('ExecutorRecoveryRefreshService', () => {
  it('checks only error classes and merges concurrent checks for the same class', async () => {
    const state = harness([
      projection('codex-cli', 'error'),
      projection('pi-agent', 'healthy'),
      projection('disabled-agent', 'disabled'),
    ]);
    let probes = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new ExecutorRecoveryRefreshService({
      statusRepo: state.repo,
      statusProjector: state.projector,
      probe: async () => {
        probes += 1;
        await gate;
        return { available: true, failure: null };
      },
    });

    const first = service.refresh({ trigger: 'planning_cycle' });
    const second = service.refresh({ trigger: 'manual', agentClassNames: ['codex-cli'] });
    release();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(probes).toBe(1);
    expect(firstReport.recovered).toEqual(['codex-cli']);
    expect(secondReport.recovered).toEqual(['codex-cli']);
    expect(firstReport.skipped).toEqual(expect.arrayContaining(['pi-agent', 'disabled-agent']));
    expect(state.values.get('codex-cli')?.classHealth).toBe('healthy');
  });

  it('records a bounded timeout failure and keeps the class in error', async () => {
    const state = harness([projection('codex-cli', 'error')]);
    const service = new ExecutorRecoveryRefreshService({
      statusRepo: state.repo,
      statusProjector: state.projector,
      probe: () => new Promise(() => undefined),
      timeoutMs: 5,
    });

    const report = await service.refresh({ trigger: 'task_recovery' });

    expect(report.stillError).toEqual(['codex-cli']);
    expect(state.values.get('codex-cli')).toMatchObject({
      classHealth: 'error',
      recentRecoveryChecks: [{
        outcome: 'probe_timeout',
        failure: { code: 'probe_timeout' },
      }],
    });
  });
});
