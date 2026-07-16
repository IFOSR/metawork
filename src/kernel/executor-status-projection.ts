export const AGENT_CLASS_HEALTH_VALUES = ['unverified', 'healthy', 'error', 'disabled'] as const;
export type AgentClassHealth = typeof AGENT_CLASS_HEALTH_VALUES[number];

export const EXECUTOR_FAILURE_KINDS = ['network', 'timeout', 'config', 'adapter', 'unknown'] as const;
export type ExecutorFailureKind = typeof EXECUTOR_FAILURE_KINDS[number];

export interface RecentExecutionAttempt {
  completedAt: string;
  outcome: 'succeeded' | 'failed';
  failureKind: ExecutorFailureKind | null;
  reason: string | null;
}

export interface KernelExecutorStatusProjection {
  agentClassName: string;
  classHealth: AgentClassHealth;
  recentAttempts: RecentExecutionAttempt[];
  updatedAt: string;
}

export function classifyExecutorFailure(message: string): ExecutorFailureKind {
  if (/network|connect|dns|econn|socket|web[_ -]?search|web[_ -]?fetch/i.test(message)) return 'network';
  if (/timeout|timed out|deadline/i.test(message)) return 'timeout';
  if (/adapter|unsupported executor|binding/i.test(message)) return 'adapter';
  if (/command not found|enoent|not recognized|configuration|config/i.test(message)) return 'config';
  return 'unknown';
}

export function projectExecutionOutcome(
  current: KernelExecutorStatusProjection | null,
  input: { agentClassName: string; outcome: 'succeeded' | 'failed'; completedAt: string; error?: string | null },
): KernelExecutorStatusProjection {
  const failureKind = input.outcome === 'failed' ? classifyExecutorFailure(input.error ?? '') : null;
  const attempt: RecentExecutionAttempt = {
    completedAt: input.completedAt,
    outcome: input.outcome,
    failureKind,
    reason: input.outcome === 'failed' ? (input.error ?? 'unknown executor failure').slice(0, 320) : null,
  };
  return {
    agentClassName: input.agentClassName,
    classHealth: input.outcome === 'succeeded'
      ? 'healthy'
      : failureKind === 'config' || failureKind === 'adapter'
        ? 'error'
        : current?.classHealth === 'disabled'
          ? 'disabled'
          : current?.classHealth === 'error'
            ? 'error'
            : current?.classHealth ?? 'unverified',
    recentAttempts: [attempt, ...(current?.recentAttempts ?? [])].slice(0, 3),
    updatedAt: input.completedAt,
  };
}
