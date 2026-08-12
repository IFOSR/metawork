import { describe, expect, it } from 'vitest';
import { ExecutorRecoveryRefreshService } from '../../src/execution/executor-recovery-refresh-service.js';
import { projectRecoveryCheck, type KernelExecutorStatusProjection } from '../../src/kernel/executor-status-projection.js';
import type {
  KernelExecutorStatusRepo,
  RevisionedKernelExecutorStatusProjection,
} from '../../src/storage/kernel-executor-status-repo.js';
import type { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';

const REVISION = 'revision-refresh';

function projection(
  agentClassName: string,
  classHealth: KernelExecutorStatusProjection['classHealth'],
  configurationRevision = REVISION,
): RevisionedKernelExecutorStatusProjection {
  return {
    agentClassName,
    configurationRevision,
    classHealth,
    recentAttempts: [],
    recentRecoveryChecks: [],
    updatedAt: '2026-07-30T00:00:00.000Z',
  };
}

function harness(initial: RevisionedKernelExecutorStatusProjection[]) {
  const key = (agentClassName: string, configurationRevision: string) =>
    `${configurationRevision}\0${agentClassName}`;
  const values = new Map(initial.map(item => [
    key(item.agentClassName, item.configurationRevision),
    item,
  ]));
  const repo = {
    list: (configurationRevision: string) => [...values.values()]
      .filter(item => item.configurationRevision === configurationRevision),
    findByAgentClassName: (name: string, configurationRevision: string) =>
      values.get(key(name, configurationRevision)) ?? null,
    upsert: (item: RevisionedKernelExecutorStatusProjection) =>
      void values.set(key(item.agentClassName, item.configurationRevision), item),
  } as unknown as KernelExecutorStatusRepo;
  const projector = {
    recordRecoveryCheck: (input: Parameters<KernelExecutorStatusProjector['recordRecoveryCheck']>[0]) => {
      const current = values.get(key(input.agentClassName, input.configurationRevision));
      if (!current || current.classHealth === 'disabled') return current ?? null;
      const next = {
        ...projectRecoveryCheck(current, { ...input, failure: input.failure ?? null }),
        configurationRevision: input.configurationRevision,
      };
      values.set(key(input.agentClassName, input.configurationRevision), next);
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
      getConfigurationRevision: () => REVISION,
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
    expect(state.values.get(`${REVISION}\0codex-cli`)?.classHealth).toBe('healthy');
  });

  it('records a bounded timeout failure and keeps the class in error', async () => {
    const state = harness([projection('codex-cli', 'error')]);
    const service = new ExecutorRecoveryRefreshService({
      statusRepo: state.repo,
      statusProjector: state.projector,
      getConfigurationRevision: () => REVISION,
      probe: () => new Promise(() => undefined),
      timeoutMs: 5,
    });

    const report = await service.refresh({ trigger: 'task_recovery' });

    expect(report.stillError).toEqual(['codex-cli']);
    expect(state.values.get(`${REVISION}\0codex-cli`)).toMatchObject({
      classHealth: 'error',
      recentRecoveryChecks: [{
        outcome: 'probe_timeout',
        failure: { code: 'probe_timeout' },
      }],
    });
  });

  it('does not merge checks or read status across configuration revisions', async () => {
    const nextRevision = 'revision-refresh-next';
    let activeRevision = REVISION;
    const state = harness([
      projection('codex-cli', 'error', REVISION),
      projection('codex-cli', 'error', nextRevision),
    ]);
    const probed: string[] = [];
    const service = new ExecutorRecoveryRefreshService({
      statusRepo: state.repo,
      statusProjector: state.projector,
      getConfigurationRevision: () => activeRevision,
      probe: async (_name, configurationRevision) => {
        probed.push(configurationRevision);
        return { available: true, failure: null };
      },
    });

    await service.refresh({ trigger: 'manual' });
    activeRevision = nextRevision;
    await service.refresh({ trigger: 'manual' });

    expect(probed).toEqual([REVISION, nextRevision]);
    expect(state.values.get(`${REVISION}\0codex-cli`)?.classHealth).toBe('healthy');
    expect(state.values.get(`${nextRevision}\0codex-cli`)?.classHealth).toBe('healthy');
  });
});
