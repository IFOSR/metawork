import type { IntentRiskLevel } from '../planning/planning-types.js';
import {
  type WorkspaceAdmission,
  type WorkspaceExecutionDecision,
  type WorkspaceExecutionMode,
  type WorkspaceIntent,
} from '../core/workspace-execution.js';
import { isWorkspaceRelativePath, normalizeWorkspaceTargetPaths } from '../workspace/workspace-path.js';

export interface WorkspaceAdmissionFacts {
  targetWorkspace: { workspaceId: string; canonicalPath: string } | null;
  /** Historical Task binding. New Tasks must never inherit a Worktree mode. */
  existingTaskBinding?: {
    workspaceId: string;
    executionMode: WorkspaceExecutionMode;
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
 * Resolve Workspace access for a new Task. There is one write model: direct
 * execution in the trusted Conversation Workspace. Read-only work receives a
 * read admission and is run with a Runtime-owned scratch directory. No path is
 * copied, no Worktree is created, and no publication policy is selected here.
 */
export function resolveWorkspaceAdmission(
  input: WorkspaceExecutionDecisionInput,
): WorkspaceExecutionResolution {
  const intent = input.intent;

  if (!input.writes) {
    if (intent && intent.operation !== 'read_only') {
      return { status: 'rejected', reason: 'a non-read-only intent cannot authorize a read admission' };
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
  if (intent.originalFilePolicy === 'unknown') {
    return {
      status: 'clarification',
      question: '请确认是否可以直接覆盖目标工作区中的原文件。',
      reason: 'Planner marked the original-file policy as unknown',
    };
  }
  if (intent.originalFilePolicy === 'must_preserve' && intent.operation !== 'create_in_target') {
    return {
      status: 'clarification',
      question: '原文件需要保留。请指定要创建的新文件路径后再继续。',
      reason: 'in-place execution cannot preserve an existing target while modifying it',
    };
  }

  const existing = input.facts.existingTaskBinding;
  if (existing) {
    if (existing.executionMode !== 'in_place') {
      return { status: 'rejected', reason: 'legacy Worktree Task bindings are no longer dispatchable' };
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
      executionMode: 'in_place',
      source: 'planner',
      reason: 'read-only admission uses a Runtime-owned scratch directory',
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
      executionMode: 'in_place',
      source: 'planner',
      reason: intent.reason,
      deliveryPolicy: 'none',
      targetPaths,
    },
  };
}

function safeTargetPaths(paths: readonly string[]): string[] | null {
  if (paths.some(path => typeof path !== 'string' || !isWorkspaceRelativePath(path))) return null;
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
  const outputs = safeTargetPaths(declaredOutputPaths);
  if (outputs === null) return null;
  return outputs.filter(output => !targetPaths.some(target => pathCoversTarget(target, output)));
}
