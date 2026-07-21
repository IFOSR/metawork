export const KERNEL_FAILURE_KINDS = [
  'network',
  'timeout',
  'infrastructure',
  'heartbeat_lost',
  'permission',
  'authentication',
  'configuration',
  'adapter',
  'capability_mismatch',
  'task_failed',
  'quality_failed',
  'cancelled',
  'stale',
  'unknown',
] as const;

export type KernelFailureKind = typeof KERNEL_FAILURE_KINDS[number];
export type KernelFailureScope = 'attempt' | 'task' | 'agent_class';

/** Bounded, sanitized failure fact accepted by the pure ControlKernel. */
export interface KernelFailure {
  kind: KernelFailureKind;
  scope: KernelFailureScope;
  code: string;
  summary: string;
}

export function kernelFailure(input: KernelFailure): KernelFailure {
  return {
    ...input,
    code: input.code.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96) || 'unknown',
    summary: input.summary.replace(/[\r\n]+/g, ' ').slice(0, 320),
  };
}
