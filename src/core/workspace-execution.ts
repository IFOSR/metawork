/**
 * Shared Workspace execution vocabulary (2026-10-25 Planner-owned Workspace
 * mode design).
 *
 * These are cross-module value types. Planning emits a `WorkspaceIntent`, the
 * Kernel resolves a `WorkspaceAdmission`, and the Runtime executes the durable
 * binding produced from that admission. Workspace access is deliberately a
 * single product model: new Tasks write in the Conversation Git Worktree and
 * publish through the Workspace merge queue.
 */

/**
 * Workspace execution modes. `conversation_git` is the only mode admitted for
 * new Tasks; `service_git` describes a service preparation round inside that
 * Worktree. The retired `in_place`/`worktree` values are historical row data
 * only and never appear in an admission decision.
 */
export type WorkspaceExecutionMode = 'conversation_git' | 'service_git';

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
 * Retired field: `unknown` used to stop admission and ask the user whether an
 * existing target file may be replaced. Conversation Git Worktree execution and
 * the merge queue own that answer now, so `originalFilePolicy` is no longer part
 * of the intent and must never gate a Turn again.
 *
 * @deprecated kept only so persisted historical intents remain readable.
 */

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
  confidence: number;
  reason: string;
}

/** Kernel-owned Workspace access fact used by new admission code. */
export type WorkspaceAdmissionKind = 'read' | 'write' | 'clarification' | 'rejected';

/**
 * Runtime-observed readiness of the Workspace Git root for Task writes.
 * `initializing` is not a blocker: Conversation binding already started
 * preparation and execution waits for it. Absent facts mean "unknown" (legacy
 * proposals) and must never be read as unavailable.
 */
export type WorkspaceWriteState = 'ready' | 'initializing' | 'failed';

/** Server-projected Workspace fact carried by a plan proposal. */
export interface WorkspaceAdmissionTargetFact {
  workspaceId: string;
  canonicalPath: string;
  writeState?: WorkspaceWriteState;
}

/**
 * Projects a persisted Workspace Git root state into the admission fact. An
 * absent root stays unknown so legacy proposals keep their existing behavior;
 * only an explicitly failed root blocks writes.
 */
export function workspaceWriteStateOf(
  root: { state: 'initializing' | 'ready' | 'recovering' | 'failed' } | null | undefined,
): WorkspaceWriteState | undefined {
  if (!root) return undefined;
  if (root.state === 'failed') return 'failed';
  return root.state === 'ready' ? 'ready' : 'initializing';
}

export interface WorkspaceAdmissionBinding {
  workspaceId: string | null;
  targetPaths: string[];
  /** The only writable directory is the Conversation-bound Git Worktree. */
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
 * Historical delivery metadata. New rounds always use `none`.
 */
export type WorkspaceDeliveryPolicy = 'none' | 'auto_publish' | 'await_acceptance';

/** Kernel-authorized Workspace execution facts consumed by the Runtime. */
export interface WorkspaceExecutionDecision {
  /** New admissions always execute in the Conversation's Git Worktree. */
  executionMode: 'conversation_git';
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
const SOURCE_SET = new Set<string>(['explicit_user', 'planner', 'fallback', 'kernel_safety']);
const DELIVERY_POLICY_SET = new Set<string>(['none', 'auto_publish', 'await_acceptance']);

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
  if (typeof operation !== 'string' || !WORKSPACE_OPERATION_SET.has(operation)) return null;
  if (!Array.isArray(record.targetPaths) || record.targetPaths.some(path => typeof path !== 'string')) return null;
  if (record.targetWorkspaceId !== null && typeof record.targetWorkspaceId !== 'string') return null;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) return null;
  if (typeof record.reason !== 'string') return null;
  return {
    targetWorkspaceId: record.targetWorkspaceId as string | null,
    targetPaths: [...record.targetPaths] as string[],
    operation: operation as WorkspaceOperation,
    confidence: record.confidence,
    reason: record.reason,
  };
}
