/**
 * Shared Workspace execution vocabulary (2026-10-25 Planner-owned Workspace
 * mode design).
 *
 * These are cross-module value types: Planning emits a `WorkspaceIntent`,
 * Control Kernel resolves a `WorkspaceExecutionDecision`, and the Execution
 * Runtime only executes the durable binding produced from that decision. The
 * owner of the vocabulary is this module so no consumer copies a near-identical
 * union of its own.
 */

export type WorkspaceExecutionMode = 'in_place' | 'worktree';

/**
 * What the user is trying to do in the target Workspace. Planner produces this;
 * Kernel never re-reads natural language to derive it.
 */
export type WorkspaceOperation =
  | 'modify_existing'
  | 'continue_existing_edit'
  | 'create_in_target'
  | 'run_in_target'
  | 'read_only'
  | 'isolated_experiment'
  | 'high_risk_change'
  | 'ambiguous';

export type WorkspaceOriginalFilePolicy = 'may_replace' | 'must_preserve' | 'unknown';
export type WorkspaceIsolationPolicy = 'requested' | 'not_requested' | 'required' | 'unknown';

/**
 * Planner-owned semantic Workspace intent. It is a proposal, never an
 * authorization: target Workspace identity must come from the trusted
 * Conversation binding, and target paths are Workspace-relative only.
 */
export interface WorkspaceIntent {
  /** Trusted Workspace identity selected by the conversation, or null when unresolved. */
  targetWorkspaceId: string | null;
  /** Workspace-relative file or directory references only; never absolute paths. */
  targetPaths: string[];
  operation: WorkspaceOperation;
  originalFilePolicy: WorkspaceOriginalFilePolicy;
  isolationPolicy: WorkspaceIsolationPolicy;
  proposedMode: WorkspaceExecutionMode | null;
  confidence: number;
  reason: string;
}

/**
 * Where the authorized mode came from. `kernel_safety` covers plans whose
 * semantics cannot be proven safe (legacy plans without an intent, inherited
 * Task bindings) and therefore keep the isolated Worktree backend.
 */
export type WorkspaceExecutionSource =
  | 'explicit_user'
  | 'planner'
  | 'fallback'
  | 'kernel_safety';

/**
 * What has to happen with a Worktree candidate before it reaches the target
 * Workspace. In-place rounds never publish, so their policy is `none`.
 */
export type WorkspaceDeliveryPolicy = 'none' | 'auto_publish' | 'await_acceptance';

/** Kernel-authorized Workspace execution facts consumed by the Runtime. */
export interface WorkspaceExecutionDecision {
  executionMode: WorkspaceExecutionMode;
  source: WorkspaceExecutionSource;
  reason: string;
  deliveryPolicy: WorkspaceDeliveryPolicy;
  /** Normalized Workspace-relative paths the Executor is expected to touch. */
  targetPaths: string[];
}

/** Default fallback for low-risk, semantically unambiguous requests. */
export const DEFAULT_WORKSPACE_FALLBACK_MODE: WorkspaceExecutionMode = 'in_place';

export const WORKSPACE_OPERATIONS: readonly WorkspaceOperation[] = [
  'modify_existing',
  'continue_existing_edit',
  'create_in_target',
  'run_in_target',
  'read_only',
  'isolated_experiment',
  'high_risk_change',
  'ambiguous',
];

const WORKSPACE_OPERATION_SET = new Set<string>(WORKSPACE_OPERATIONS);
const EXECUTION_MODE_SET = new Set<string>(['in_place', 'worktree']);
const ORIGINAL_FILE_POLICY_SET = new Set<string>(['may_replace', 'must_preserve', 'unknown']);
const ISOLATION_POLICY_SET = new Set<string>(['requested', 'not_requested', 'required', 'unknown']);
const SOURCE_SET = new Set<string>(['explicit_user', 'planner', 'fallback', 'kernel_safety']);
const DELIVERY_POLICY_SET = new Set<string>(['none', 'auto_publish', 'await_acceptance']);

export function isWorkspaceExecutionMode(value: unknown): value is WorkspaceExecutionMode {
  return typeof value === 'string' && EXECUTION_MODE_SET.has(value);
}

export function isWorkspaceExecutionSource(value: unknown): value is WorkspaceExecutionSource {
  return typeof value === 'string' && SOURCE_SET.has(value);
}

export function isWorkspaceDeliveryPolicy(value: unknown): value is WorkspaceDeliveryPolicy {
  return typeof value === 'string' && DELIVERY_POLICY_SET.has(value);
}

/**
 * Defensive reader for a persisted intent. Old plans have none, and a hand
 * edited record must not be interpreted as a stronger authorization than it is.
 */
export function parseWorkspaceIntent(value: unknown): WorkspaceIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const operation = record.operation;
  const originalFilePolicy = record.originalFilePolicy;
  const isolationPolicy = record.isolationPolicy;
  const proposedMode = record.proposedMode;
  if (typeof operation !== 'string' || !WORKSPACE_OPERATION_SET.has(operation)) return null;
  if (typeof originalFilePolicy !== 'string' || !ORIGINAL_FILE_POLICY_SET.has(originalFilePolicy)) return null;
  if (typeof isolationPolicy !== 'string' || !ISOLATION_POLICY_SET.has(isolationPolicy)) return null;
  if (proposedMode !== null && !isWorkspaceExecutionMode(proposedMode)) return null;
  if (!Array.isArray(record.targetPaths) || record.targetPaths.some(path => typeof path !== 'string')) return null;
  if (record.targetWorkspaceId !== null && typeof record.targetWorkspaceId !== 'string') return null;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null;
  if (typeof record.reason !== 'string') return null;
  return {
    targetWorkspaceId: record.targetWorkspaceId as string | null,
    targetPaths: [...record.targetPaths] as string[],
    operation: operation as WorkspaceOperation,
    originalFilePolicy: originalFilePolicy as WorkspaceOriginalFilePolicy,
    isolationPolicy: isolationPolicy as WorkspaceIsolationPolicy,
    proposedMode: proposedMode as WorkspaceExecutionMode | null,
    confidence: record.confidence,
    reason: record.reason,
  };
}
