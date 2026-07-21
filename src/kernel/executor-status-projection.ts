import { kernelFailure, type KernelFailure } from '../core/kernel-failure.js';

export const AGENT_CLASS_HEALTH_VALUES = ['unverified', 'healthy', 'error', 'disabled'] as const;
export type AgentClassHealth = typeof AGENT_CLASS_HEALTH_VALUES[number];

export interface RecentExecutionAttempt {
  attemptId?: string;
  completedAt: string;
  outcome: 'succeeded' | 'failed';
  failure: KernelFailure | null;
}

export interface KernelExecutorStatusProjection {
  agentClassName: string;
  classHealth: AgentClassHealth;
  recentAttempts: RecentExecutionAttempt[];
  updatedAt: string;
}

export function projectExecutionOutcome(
  current: KernelExecutorStatusProjection | null,
  input: {
    agentClassName: string;
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    completedAt: string;
    failure?: KernelFailure | null;
  },
): KernelExecutorStatusProjection {
  if (current?.recentAttempts.some(attempt => attempt.attemptId === input.attemptId)) {
    return current;
  }
  const failure = input.outcome === 'failed'
    ? kernelFailure(input.failure ?? { kind: 'unknown', scope: 'attempt', code: 'unknown', summary: 'unknown executor failure' })
    : null;
  const attempt: RecentExecutionAttempt = {
    attemptId: input.attemptId,
    completedAt: input.completedAt,
    outcome: input.outcome,
    failure,
  };
  const permanentClassFault = failure?.scope === 'agent_class'
    && ['authentication', 'configuration', 'adapter'].includes(failure.kind);
  return {
    agentClassName: input.agentClassName,
    classHealth: current?.classHealth === 'disabled'
      ? 'disabled'
      : input.outcome === 'succeeded'
        ? 'healthy'
        : permanentClassFault
          ? 'error'
          : current?.classHealth ?? 'unverified',
    recentAttempts: [attempt, ...(current?.recentAttempts ?? [])].slice(0, 10),
    updatedAt: input.completedAt,
  };
}
