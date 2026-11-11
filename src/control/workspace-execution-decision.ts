import type { IntentRiskLevel } from '../planning/planning-types.js';
import {
  type WorkspaceAdmission,
  type WorkspaceAdmissionTargetFact,
  type WorkspaceExecutionDecision,
  type WorkspaceExecutionMode,
  type WorkspaceIntent,
} from '../core/workspace-execution.js';
import { normalizeWorkspaceTargetPaths } from '../workspace/workspace-path.js';
import { isValidFileOutput } from '../work-graph/file-outputs.js';

export interface WorkspaceAdmissionFacts {
  targetWorkspace: WorkspaceAdmissionTargetFact | null;
  /**
   * Historical Task binding read from the Task row. Retired product modes are
   * accepted here only so the admission can reject them explicitly.
   */
  existingTaskBinding?: {
    workspaceId: string;
    executionMode: WorkspaceExecutionMode | 'in_place' | 'worktree';
    deliveryPolicy?: 'none' | 'auto_publish' | 'await_acceptance';
  } | null;
}
export interface WorkspaceExecutionDecisionInput {
  intent: WorkspaceIntent | null;
  facts: WorkspaceAdmissionFacts;
  riskLevel: IntentRiskLevel;
  writes: boolean;
  declaredOutputPaths?: readonly string[];
}

export type WorkspaceExecutionResolution =
  | {
      status: 'resolved';
      decision: WorkspaceExecutionDecision;
      admission: Extract<WorkspaceAdmission, { kind: 'read' | 'write' }>;
      intent: WorkspaceIntent | null;
    }
  | { status: 'clarification'; question: string; reason: string }
  | { status: 'rejected'; reason: string };

/**
 * Resolve Workspace access for a new Task. There is one execution model:
 * Conversation Git Worktree execution. Read-only work still receives the same
 * Conversation binding; if it produces no changes, no merge item is created.
 */
export function resolveWorkspaceAdmission(
  input: WorkspaceExecutionDecisionInput,
): WorkspaceExecutionResolution {
  const intent = input.intent;

  if (!input.writes) {
    if (intent && intent.operation !== 'read_only') {
      // Plan validation already turns this mismatch into repairable feedback.
      // If a persisted or non-plan call still reaches admission, fail with a
      // bounded, actionable reason instead of leaking the internal invariant.
      return {
        status: 'rejected',
        reason: `工作区意图声明了 ${intent.operation}，但计划没有任何需要独占访问的子任务；`
          + "请把运行或终止进程的子任务标记为 workspaceEffect 'write' 后重试"
          + '（code: workspace_intent_requires_write）',
      };
    }
    const declaredOutputs = safeTargetPaths(input.declaredOutputPaths ?? []);
    if (declaredOutputs === null) {
      return { status: 'rejected', reason: 'the Work Graph declares an unsafe or non-relative file output path' };
    }
    if (declaredOutputs.length > 0) {
      return { status: 'rejected', reason: 'read-only Workspace work cannot declare file outputs' };
    }
    return resolvedRead(input, intent);
  }

  if (!intent) {
    return {
      status: 'rejected',
      reason: 'new Workspace writes require a structured Workspace intent; legacy Worktree plans are not dispatchable',
    };
  }
  if (intent.operation === 'read_only') {
    return { status: 'rejected', reason: 'a read-only Workspace intent cannot authorize a write Work Graph' };
  }
  if (intent.operation === 'ambiguous') {
    return {
      status: 'clarification',
      question: '请说明这次操作涉及目标工作区中的哪些文件或目录，然后再继续。',
      reason: 'Workspace intent is ambiguous',
    };
  }
  if (!Number.isFinite(intent.confidence) || intent.confidence < 0 || intent.confidence > 1) {
    return { status: 'rejected', reason: 'Workspace intent confidence must be within 0..1' };
  }
  if (!intent.reason.trim()) return { status: 'rejected', reason: 'Workspace intent requires a non-empty reason' };

  const targetPaths = safeTargetPaths(intent.targetPaths);
  if (targetPaths === null) {
    return { status: 'rejected', reason: 'Workspace intent contains an unsafe or non-relative target path' };
  }
  if (targetPaths.length === 0) {
    return {
      status: 'clarification',
      question: '请说明这次操作涉及目标工作区中的哪些文件或目录，然后再继续。',
      reason: 'a writing Workspace intent must declare at least one target path',
    };
  }
  const uncoveredOutputs = uncoveredDeclaredOutputs(targetPaths, input.declaredOutputPaths ?? []);
  if (uncoveredOutputs === null) {
    return { status: 'rejected', reason: 'the Work Graph declares an unsafe or non-relative file output path' };
  }
  if (uncoveredOutputs.length > 0) {
    return {
      status: 'rejected',
      reason: `declared file outputs are outside workspaceIntent.targetPaths: ${uncoveredOutputs.join(', ')}`,
    };
  }

  const target = input.facts.targetWorkspace;
  if (!target) {
    return {
      status: 'clarification',
      question: '请先为目标任务选择工作区，然后再继续。',
      reason: 'no Workspace is bound to this Conversation',
    };
  }
  if (target.writeState === 'failed') {
    // Runtime owns the real blocker: a broken Workspace Git root is not a user
    // intent question, so it fails the Turn with an actionable reason instead of
    // asking the user what the Manager is allowed to do.
    return {
      status: 'rejected',
      reason: `the Workspace Git root for ${target.workspaceId} is unavailable; repair the Workspace and retry`,
    };
  }
  if (intent.targetWorkspaceId && intent.targetWorkspaceId !== target.workspaceId) {
    return {
      status: 'rejected',
      reason: `Workspace intent targets ${intent.targetWorkspaceId}, which is not the Conversation-bound Workspace ${target.workspaceId}`,
    };
  }
  if (intent.confidence < 0.3) {
    return {
      status: 'clarification',
      question: '请确认这次修改应该直接写入目标工作区中的哪些文件或目录。',
      reason: 'Workspace intent confidence is too low to authorize a write',
    };
  }
  // `originalFilePolicy` used to gate writes here ("may the existing target be
  // replaced?"). Execution is Conversation Git Worktree + merge queue, so that
  // question is answered by the published diff, not by an admission gate; the
  // field is retired and must not stop a Turn.

  const existing = input.facts.existingTaskBinding;
  if (existing) {
    if (existing.executionMode === 'worktree' || existing.executionMode === 'in_place') {
      return {
        status: 'rejected',
        reason: `historical Task ${existing.executionMode} bindings are no longer dispatchable`,
      };
    }
    if (existing.workspaceId && existing.workspaceId !== target.workspaceId) {
      return {
        status: 'rejected',
        reason: `Task is bound to ${existing.workspaceId}, not the Conversation-bound Workspace ${target.workspaceId}`,
      };
    }
  }

  return resolvedWrite(target.workspaceId, targetPaths, intent);
}

/** Compatibility export retained for callers while they migrate to admission terminology. */
export const resolveWorkspaceExecutionDecision = resolveWorkspaceAdmission;

function resolvedRead(
  input: WorkspaceExecutionDecisionInput,
  intent: WorkspaceIntent | null,
): WorkspaceExecutionResolution {
  const targetPaths = safeTargetPaths(intent?.targetPaths ?? []);
  if (targetPaths === null) {
    return { status: 'rejected', reason: 'Workspace intent contains an unsafe or non-relative target path' };
  }
  const workspaceId = input.facts.targetWorkspace?.workspaceId ?? null;
  return {
    status: 'resolved',
    intent,
    admission: { kind: 'read', workspaceId, targetPaths },
    decision: {
      executionMode: 'conversation_git',
      source: 'planner',
      reason: 'read-only admission uses the Conversation Git Worktree and creates no merge item when unchanged',
      deliveryPolicy: 'none',
      targetPaths,
    },
  };
}

function resolvedWrite(
  workspaceId: string,
  targetPaths: string[],
  intent: WorkspaceIntent,
): WorkspaceExecutionResolution {
  return {
    status: 'resolved',
    intent,
    admission: { kind: 'write', workspaceId, targetPaths },
    decision: {
      executionMode: 'conversation_git',
      source: 'planner',
      reason: intent.reason,
      deliveryPolicy: 'none',
      targetPaths,
    },
  };
}

/**
 * Intent targets use the production normalizer, which also accepts the
 * `directory/` spelling the Planner schema permits. Routing both through one
 * entry keeps schema, admission and persistence on the same canonical path
 * (convergence review B-03).
 */
function safeTargetPaths(paths: readonly string[]): string[] | null {
  if (!paths.every(path => typeof path === 'string' && path.length > 0)) return null;
  try {
    return normalizeWorkspaceTargetPaths(paths);
  } catch {
    return null;
  }
}

function pathCoversTarget(target: string, path: string): boolean {
  return target === path || path.startsWith(`${target}/`);
}

function uncoveredDeclaredOutputs(
  targetPaths: readonly string[],
  declaredOutputPaths: readonly string[],
): string[] | null {
  // A declared output may name a dedicated directory prefix ending in `/`
  // (ADR-0032 amendment). Its coverage is compared on the directory scope, so
  // validation matches the same `fileOutputs` grammar the rest of the product
  // uses instead of rejecting the directory spelling.
  const outputs: string[] = [];
  for (const path of declaredOutputPaths) {
    if (typeof path !== 'string' || !isValidFileOutput(path)) return null;
    outputs.push(path.replace(/\/+$/u, ''));
  }
  return outputs.filter(output => !targetPaths.some(target => pathCoversTarget(target, output)));
}
