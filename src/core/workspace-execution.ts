/**
 * Shared Workspace execution vocabulary (2026-10-25 Planner-owned Workspace
 * mode design).
 *
 * These are cross-module value types. Planning emits a `WorkspaceIntent`, the
 * Kernel resolves a `WorkspaceAdmission`, and the Runtime executes the durable
 * binding produced from that admission. Workspace access is deliberately a
 * single product model: writes happen in the Conversation-bound Workspace and
 * reads use a bounded scratch directory.
 */

/** Runtime mode retained only to identify and reject historical Worktree rows. */
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
  | 'ambiguous';

export type WorkspaceOriginalFilePolicy = 'may_replace' | 'must_preserve' | 'unknown';

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
  confidence: number;
  reason: string;
}

/** Kernel-owned Workspace access fact used by new admission code. */
export type WorkspaceAdmissionKind = 'read' | 'write' | 'clarification' | 'rejected';

export interface WorkspaceAdmissionBinding {
  workspaceId: string | null;
  targetPaths: string[];
  /** The only writable directory is the Conversation-bound Workspace root. */
  authorizedWorkingDirectory?: string;
}

export type WorkspaceAdmission =
  | { kind: 'read'; workspaceId: string | null; targetPaths: string[] }
  | { kind: 'write'; workspaceId: string; targetPaths: string[] }
  | { kind: 'clarification'; question: string; reason: string }
  | { kind: 'rejected'; reason: string };

/**
 * Historical source metadata retained for projections. New admissions always
 * use `planner`; `fallback` and `kernel_safety` identify old records only.
 */
export type WorkspaceExecutionSource =
  | 'explicit_user'
  | 'planner'
  | 'fallback'
  | 'kernel_safety';

/**
 * Historical delivery metadata. New in-place rounds always use `none`.
 */
export type WorkspaceDeliveryPolicy = 'none' | 'auto_publish' | 'await_acceptance';

/** Kernel-authorized Workspace execution facts consumed by the Runtime. */
export interface WorkspaceExecutionDecision {
  executionMode: 'in_place';
  source: 'planner';
  reason: string;
  deliveryPolicy: 'none';
  /** Normalized Workspace-relative paths the Executor is expected to touch. */
  targetPaths: string[];
}

export const WORKSPACE_OPERATIONS: readonly WorkspaceOperation[] = [
  'modify_existing',
  'continue_existing_edit',
  'create_in_target',
  'run_in_target',
  'read_only',
  'ambiguous',
];

const WORKSPACE_OPERATION_SET = new Set<string>(WORKSPACE_OPERATIONS);
const EXECUTION_MODE_SET = new Set<string>(['in_place', 'worktree']);
const ORIGINAL_FILE_POLICY_SET = new Set<string>(['may_replace', 'must_preserve', 'unknown']);
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
  if (typeof operation !== 'string' || !WORKSPACE_OPERATION_SET.has(operation)) return null;
  if (typeof originalFilePolicy !== 'string' || !ORIGINAL_FILE_POLICY_SET.has(originalFilePolicy)) return null;
  if (!Array.isArray(record.targetPaths) || record.targetPaths.some(path => typeof path !== 'string')) return null;
  if (record.targetWorkspaceId !== null && typeof record.targetWorkspaceId !== 'string') return null;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null;
  if (typeof record.reason !== 'string') return null;
  return {
    targetWorkspaceId: record.targetWorkspaceId as string | null,
    targetPaths: [...record.targetPaths] as string[],
    operation: operation as WorkspaceOperation,
    originalFilePolicy: originalFilePolicy as WorkspaceOriginalFilePolicy,
    confidence: record.confidence,
    reason: record.reason,
  };
}
