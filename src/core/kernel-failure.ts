export const KERNEL_FAILURE_KINDS = [
  'network',
  'timeout',
  'infrastructure',
  'heartbeat_lost',
  'permission',
  'authentication',
  'provider_quota',
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
export type KernelFailureOrigin = 'planner' | 'executor' | 'harness' | 'provider' | 'kernel';

/** Which Executor/Attempt produced the failure, so the Client can name the step. */
export interface KernelFailureActor {
  agentClassRef?: string;
  harnessRef?: string;
  providerRef?: string;
  modelRef?: string;
  attemptId?: string;
  subtaskId?: string;
}

export interface KernelFailureProvider {
  /** HTTP status returned by the model provider, when the failure came from one. */
  httpStatus?: number;
  requestId?: string;
}

/**
 * Bounded, sanitized failure fact shared by Adapter normalization and ControlKernel.
 *
 * `summary` is the passthrough of the upstream error text: Planner and Executor
 * failures must reach the Client as they happened, together with where they
 * happened. `label` is only an optional user-facing headline layered on top of
 * that text, never a replacement for it.
 */
export interface KernelFailure {
  kind: KernelFailureKind;
  scope: KernelFailureScope;
  code: string;
  summary: string;
  label?: string;
  /** Bounded upstream tail (multi-line) for the full-trajectory view. */
  detail?: string;
  origin?: KernelFailureOrigin;
  stage?: string;
  actor?: KernelFailureActor;
  provider?: KernelFailureProvider;
  /** Last step the Executor reached before failing, when the harness reports it. */
  step?: string;
}

export function kernelFailure(input: KernelFailure): KernelFailure {
  return {
    ...input,
    code: input.code.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96) || 'unknown',
    summary: input.summary.replace(/[\r\n]+/g, ' ').slice(0, 320),
    ...(input.label ? { label: singleLine(input.label, 200) } : {}),
    ...(input.detail ? { detail: boundedDetail(input.detail) } : {}),
    ...(input.actor ? { actor: sanitizedActor(input.actor) } : {}),
    ...(input.provider ? { provider: sanitizedProvider(input.provider) } : {}),
    ...(input.step ? { step: singleLine(input.step, 200) } : {}),
  };
}

function singleLine(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedDetail(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(-4_000);
}

function sanitizedActor(actor: KernelFailureActor): KernelFailureActor {
  const entries = Object.entries(actor)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => [key, singleLine(String(value), 200)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) as KernelFailureActor : {};
}

function sanitizedProvider(provider: KernelFailureProvider): KernelFailureProvider {
  const httpStatus = Number.isInteger(provider.httpStatus)
    && provider.httpStatus! >= 100
    && provider.httpStatus! <= 599
    ? provider.httpStatus
    : undefined;
  const requestId = provider.requestId ? singleLine(provider.requestId, 200) : undefined;
  return {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
