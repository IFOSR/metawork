import { describe, expect, it } from 'vitest';
import { deriveAgentAvailability } from '../../src/kernel/agent-availability.js';
import type { KernelExecutorStatusProjection } from '../../src/kernel/executor-status-projection.js';

describe('deriveAgentAvailability', () => {
  it('derives cooldown and probe eligibility from three consecutive attributable failures', () => {
    const projection = status([
      failureAt('2026-07-21T00:02:00.000Z', 'network'),
      failureAt('2026-07-21T00:01:00.000Z', 'timeout'),
      failureAt('2026-07-21T00:00:00.000Z', 'infrastructure'),
    ]);

    expect(deriveAgentAvailability(projection, '2026-07-21T00:06:59.999Z')).toBe('temporarily_unavailable');
    expect(deriveAgentAvailability(projection, '2026-07-21T00:07:00.000Z')).toBe('probe_eligible');
  });

  it('does not treat capacity, task failure, contract failure, or a non-consecutive history as a circuit fact', () => {
    const projection = status([
      failureAt('2026-07-21T00:02:00.000Z', 'network'),
      {
        completedAt: '2026-07-21T00:01:30.000Z',
        outcome: 'failed',
        failure: { kind: 'task_failed', scope: 'task', code: 'executor_reported_task_failure', summary: 'tests failed' },
      },
      failureAt('2026-07-21T00:01:00.000Z', 'network'),
      failureAt('2026-07-21T00:00:00.000Z', 'network'),
    ]);

    expect(deriveAgentAvailability(projection, '2026-07-21T00:03:00.000Z')).toBe('available');
  });

  it('treats disabled and confirmed class-level configuration faults as permanently unavailable', () => {
    expect(deriveAgentAvailability(status([], 'disabled'), '2026-07-21T00:00:00.000Z')).toBe('permanently_unavailable');
    expect(deriveAgentAvailability(status([{
      completedAt: '2026-07-21T00:00:00.000Z',
      outcome: 'failed',
      failure: { kind: 'configuration', scope: 'agent_class', code: 'missing_binary', summary: 'binary missing' },
    }], 'error'), '2026-07-21T00:00:01.000Z')).toBe('permanently_unavailable');
  });
});

function failureAt(
  completedAt: string,
  kind: 'network' | 'timeout' | 'infrastructure',
): KernelExecutorStatusProjection['recentAttempts'][number] {
  return {
    completedAt,
    outcome: 'failed',
    failure: { kind, scope: 'agent_class', code: `${kind}_failure`, summary: `${kind} failed` },
  };
}

function status(
  recentAttempts: KernelExecutorStatusProjection['recentAttempts'],
  classHealth: KernelExecutorStatusProjection['classHealth'] = 'healthy',
): KernelExecutorStatusProjection {
  return { agentClassName: 'codex-cli', classHealth, recentAttempts, updatedAt: '2026-07-21T00:02:00.000Z' };
}
