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

export type ControlFailureKind = typeof KERNEL_FAILURE_KINDS[number];
export type ControlFailureScope = 'attempt' | 'task' | 'agent_class';
export type ControlFailureOrigin = 'planner' | 'executor' | 'harness' | 'provider' | 'kernel';

/** Which Executor/Attempt produced the failure, so the Client can name the step. */
export interface ControlFailureActor {
  agentClassRef?: string;
  harnessRef?: string;
  providerRef?: string;
  modelRef?: string;
  attemptId?: string;
  subtaskId?: string;
}

export interface ControlFailureProvider {
  /** HTTP status returned by the model provider, when the failure came from one. */
  httpStatus?: number;
  requestId?: string;
}

/**
 * Bounded, sanitized failure fact shared by Adapter normalization and the old Kernel.
 *
 * `summary` is the passthrough of the upstream error text: Planner and Executor
 * failures must reach the Client as they happened, together with where they
 * happened. `label` is only an optional user-facing headline layered on top of
 * that text, never a replacement for it.
 */
export interface ControlFailure {
  kind: ControlFailureKind;
  scope: ControlFailureScope;
  code: string;
  summary: string;
  label?: string;
  /** Bounded upstream tail (multi-line) for the full-trajectory view. */
  detail?: string;
  origin?: ControlFailureOrigin;
  stage?: string;
  actor?: ControlFailureActor;
  provider?: ControlFailureProvider;
  /** Last step the Executor reached before failing, when the harness reports it. */
  step?: string;
  /** Stable execution facts shared by Web, TUI and remote gateways. */
  retryable?: boolean;
  attemptStarted?: boolean;
  externalSideEffect?: boolean | 'unknown';
  userAction?: string;
}

export function kernelFailure(input: ControlFailure): ControlFailure {
  return {
    ...input,
    code: input.code.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96) || 'unknown',
    summary: input.summary.replace(/[\r\n]+/g, ' ').slice(0, 320),
    ...(input.label ? { label: singleLine(input.label, 200) } : {}),
    ...(input.detail ? { detail: boundedDetail(input.detail) } : {}),
    ...(input.actor ? { actor: sanitizedActor(input.actor) } : {}),
    ...(input.provider ? { provider: sanitizedProvider(input.provider) } : {}),
    ...(input.step ? { step: singleLine(input.step, 200) } : {}),
    ...(input.userAction ? { userAction: singleLine(input.userAction, 320) } : {}),
  };
}

function singleLine(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedDetail(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(-4_000);
}

function sanitizedActor(actor: ControlFailureActor): ControlFailureActor {
  const entries = Object.entries(actor)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => [key, singleLine(String(value), 200)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) as ControlFailureActor : {};
}

function sanitizedProvider(provider: ControlFailureProvider): ControlFailureProvider {
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
