import type { IntentRiskLevel } from '../planning/planning-types.js';
import {
  DEFAULT_WORKSPACE_FALLBACK_MODE,
  type WorkspaceDeliveryPolicy,
  type WorkspaceExecutionDecision,
  type WorkspaceExecutionMode,
  type WorkspaceIntent,
} from '../core/workspace-execution.js';
import { isWorkspaceRelativePath, normalizeWorkspaceTargetPaths } from '../workspace/workspace-path.js';

/**
 * Server-projected Workspace facts for one plan admission. Kernel never reads
 * the filesystem: the Application Shell canonicalizes the Conversation-bound
 * Workspace and hands the facts in, exactly like the other admission snapshots.
 */
export interface WorkspaceAdmissionFacts {
  /** Active configuration fallback for low-risk requests with no Planner mode. */
  fallbackMode?: WorkspaceExecutionMode;
  /** Conversation-bound target Workspace, or null when it cannot be resolved. */
  targetWorkspace: {
    workspaceId: string;
    canonicalPath: string;
  } | null;
  /**
   * Fixed binding of an existing Task. Mode is immutable per Task, so a
   * replan/retry inherits it instead of re-deciding semantics.
   */
  existingTaskBinding?: {
    workspaceId: string;
    executionMode: WorkspaceExecutionMode;
    deliveryPolicy: WorkspaceDeliveryPolicy;
  } | null;
  /** Whether the Worktree execution backend can create an internal root. */
  worktreeAvailable?: boolean;
}

export interface WorkspaceExecutionDecisionInput {
  /** `null` for legacy plans persisted before the Workspace intent contract. */
  intent: WorkspaceIntent | null;
  facts: WorkspaceAdmissionFacts;
  riskLevel: IntentRiskLevel;
  /** True when the admitted plan is a Work Graph (writes) rather than a control action. */
  writes: boolean;
  /** Declared file outputs must be covered by the Planner's Workspace target paths. */
  declaredOutputPaths?: readonly string[];
}

export type WorkspaceExecutionResolution =
  | { status: 'resolved'; decision: WorkspaceExecutionDecision; intent: WorkspaceIntent | null }
  | { status: 'clarification'; question: string; reason: string }
  | { status: 'rejected'; reason: string };

const IN_PLACE_SAFE_OPERATIONS = new Set([
  'modify_existing',
  'continue_existing_edit',
  'create_in_target',
  'run_in_target',
]);

/**
 * Single Workspace execution decision. Planner supplies the semantics; Kernel
 * only validates constraints, pins the immutable binding and authorizes the
 * side effect. Clarification never creates a Task, Attempt, Worktree or write
 * lease — the caller simply returns `request_clarification`.
 */
export function resolveWorkspaceExecutionDecision(
  input: WorkspaceExecutionDecisionInput,
): WorkspaceExecutionResolution {
  if (!input.writes) {
    // A report/read-only graph may still need a filesystem for reads or
    // executor scratch files. Keep that filesystem in the private Worktree
    // backend so a `read_only` semantic intent can never grant writes to the
    // user's Workspace. Delivery remains disabled because there is no
    // authorized Workspace change to publish.
    if (input.facts.worktreeAvailable === false) {
      return {
        status: 'rejected',
        reason: 'the isolated backend is unavailable for a non-writing execution',
      };
    }
    return {
      status: 'resolved',
      intent: input.intent,
      decision: {
        executionMode: 'worktree',
        source: 'kernel_safety',
        reason: 'action does not authorize writes to a user Workspace',
        deliveryPolicy: 'none',
        targetPaths: [],
      },
    };
  }
  const fallbackMode = input.facts.fallbackMode ?? DEFAULT_WORKSPACE_FALLBACK_MODE;
  const existing = input.facts.existingTaskBinding ?? null;

  // 1. An already-authorized Task keeps its mode. A new generation, a retry or
  // a follow-up must never silently execute somewhere else.
  if (existing) {
    if (input.intent?.proposedMode && input.intent.proposedMode !== existing.executionMode) {
      return {
        status: 'clarification',
        question: '这个任务已固定在'
          + (existing.executionMode === 'in_place' ? '目标工作区就地执行' : '隔离执行环境')
          + '，是否新建任务来改变执行方式？',
        reason: `existing Task binding fixes executionMode=${existing.executionMode}`,
      };
    }
    if (
      input.intent?.targetWorkspaceId
      && input.intent.targetWorkspaceId !== existing.workspaceId
    ) {
      return {
        status: 'rejected',
        reason: `Workspace intent targets ${input.intent.targetWorkspaceId}, but the Task is bound to ${existing.workspaceId}`,
      };
    }
    const targetPaths = safeTargetPaths(input.intent?.targetPaths ?? []);
    if (targetPaths === null) {
      return {
        status: 'rejected',
        reason: 'Workspace intent contains an unsafe or non-relative target path',
      };
    }
    const uncoveredOutputs = uncoveredDeclaredOutputs(targetPaths, input.declaredOutputPaths ?? []);
    if (uncoveredOutputs === null) {
      return {
        status: 'rejected',
        reason: 'the Work Graph declares an unsafe or non-relative file output path',
      };
    }
    if (uncoveredOutputs.length > 0) {
      return {
        status: 'rejected',
        reason: `declared file outputs are outside workspaceIntent.targetPaths: ${uncoveredOutputs.join(', ')}`,
      };
    }
    return {
      status: 'resolved',
      intent: input.intent,
      decision: {
        executionMode: existing.executionMode,
        source: 'kernel_safety',
        reason: `inherits the immutable Task binding (${existing.executionMode})`,
        deliveryPolicy: existing.deliveryPolicy,
        targetPaths,
      },
    };
  }

  // 2. Legacy plans carry no structured intent. Their semantics cannot be
  // proven safe, so the isolated backend stays the conservative conclusion and
  // the target Workspace is never written before an authorized publication.
  if (!input.intent) {
    if (input.facts.worktreeAvailable === false) {
      return {
        status: 'rejected',
        reason: 'this plan has no Workspace intent and the isolated worktree backend is unavailable',
      };
    }
    return {
      status: 'resolved',
      intent: null,
      decision: {
        executionMode: 'worktree',
        source: 'kernel_safety',
        reason: 'plan carries no Workspace intent; isolated execution is the safe default',
        // A legacy plan has no structured evidence that the user authorized
        // writing the candidate back. Isolation therefore stops at an explicit
        // acceptance gate; it must never become an implicit publication grant.
        deliveryPolicy: 'await_acceptance',
        targetPaths: [],
      },
    };
  }

  const intent = input.intent;
  if (!Number.isFinite(intent.confidence) || intent.confidence < 0 || intent.confidence > 1) {
    return { status: 'rejected', reason: 'Workspace intent confidence must be within 0..1' };
  }
  if (!intent.reason.trim()) {
    return { status: 'rejected', reason: 'Workspace intent requires a non-empty reason' };
  }
  if (intent.operation === 'ambiguous') {
    return {
      status: 'clarification',
      question: '请说明结果应该写回目标工作区，还是先保留为待接受的候选版本？',
      reason: 'Workspace intent is ambiguous',
    };
  }
  if (intent.operation === 'read_only') {
    return {
      status: 'rejected',
      reason: 'a read-only Workspace intent cannot authorize a write Work Graph',
    };
  }
  const targetPaths = safeTargetPaths(intent.targetPaths);
  if (targetPaths === null) {
    return {
      status: 'rejected',
      reason: 'Workspace intent contains an unsafe or non-relative target path',
    };
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
    return {
      status: 'rejected',
      reason: 'the Work Graph declares an unsafe or non-relative file output path',
    };
  }
  if (uncoveredOutputs.length > 0) {
    return {
      status: 'rejected',
      reason: `declared file outputs are outside workspaceIntent.targetPaths: ${uncoveredOutputs.join(', ')}`,
    };
  }

  // 3. The target Workspace identity comes from the trusted Conversation
  // binding, never from Planner text. An explicit intent must agree with it.
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
      question: '请确认这次修改应该直接写入目标工作区，还是先保留为候选版本？',
      reason: 'Workspace intent confidence is too low to authorize a write',
    };
  }

  if (intent.proposedMode === 'in_place') {
    if (intent.originalFilePolicy === 'unknown' || intent.isolationPolicy === 'unknown') {
      return {
        status: 'clarification',
        question: '请确认是否可以直接覆盖目标工作区中的原文件，还是需要先保留候选版本？',
        reason: 'Planner marked the file or isolation policy as unknown',
      };
    }
    if (intent.isolationPolicy === 'required'
      || intent.isolationPolicy === 'requested'
      || intent.operation === 'isolated_experiment') {
      return {
        status: 'rejected',
        reason: 'Planner proposed in_place while the request requires isolation',
      };
    }
    return {
      status: 'resolved',
      intent,
      decision: {
        executionMode: 'in_place',
        source: 'planner',
        reason: intent.reason,
        deliveryPolicy: 'none',
        targetPaths,
      },
    };
  }

  if (intent.proposedMode === 'worktree') {
    if (!hasIsolationRationale(intent)) {
      return {
        status: 'rejected',
        reason: 'a worktree proposal must state an isolation, risk, candidate or acceptance rationale',
      };
    }
    if (input.facts.worktreeAvailable === false) {
      return {
        status: 'rejected',
        reason: 'the isolated worktree backend is unavailable; in-place isolation cannot be promised',
      };
    }
    return {
      status: 'resolved',
      intent,
      decision: {
        executionMode: 'worktree',
        source: 'planner',
        reason: intent.reason,
        deliveryPolicy: worktreeDeliveryPolicy(intent),
        targetPaths,
      },
    };
  }

  // 4. Planner gave no mode. The configured fallback may only be used for a
  // low-risk, semantically unambiguous request; everything else asks the user.
  if (input.riskLevel === 'high') {
    return {
      status: 'clarification',
      question: '这次修改风险较高。请确认是否直接在目标工作区执行，还是先生成待接受的候选版本？',
      reason: 'high-risk Workspace change without an explicit mode',
    };
  }
  if (!isFallbackSafe(intent)) {
    return {
      status: 'clarification',
      question: intent.originalFilePolicy === 'must_preserve'
        ? '需要保留原文件：请在目标工作区另存为新文件，还是先生成待接受的候选版本？'
        : '请确认结果应该写回目标工作区，还是先保留为待接受的候选版本？',
      reason: 'Workspace semantics require an explicit user decision',
    };
  }
  if (fallbackMode === 'in_place') {
    return {
      status: 'resolved',
      intent,
      decision: {
        executionMode: 'in_place',
        source: 'fallback',
        reason: `Planner did not choose a mode; low-risk fallback is in_place`,
        deliveryPolicy: 'none',
        targetPaths,
      },
    };
  }
  if (input.facts.worktreeAvailable === false) {
    return {
      status: 'clarification',
      question: '当前环境无法创建隔离执行目录。请确认是否直接在目标工作区执行这次修改？',
      reason: 'configured fallback mode worktree is unavailable',
    };
  }
  return {
    status: 'resolved',
    intent,
    decision: {
      executionMode: 'worktree',
      source: 'fallback',
      reason: 'Planner did not choose a mode; configured fallback is worktree',
      // The fallback selects an execution backend only. It is not a user
      // authorization to publish an isolated candidate automatically.
      deliveryPolicy: 'await_acceptance',
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

function hasIsolationRationale(intent: WorkspaceIntent): boolean {
  return intent.isolationPolicy === 'requested'
    || intent.isolationPolicy === 'required'
    || intent.operation === 'isolated_experiment'
    || intent.operation === 'high_risk_change'
    || intent.originalFilePolicy === 'must_preserve'
    || /\b(candidate|accept|review|isolat)/iu.test(intent.reason)
    || /(候选|接受|审核|隔离|保留原文件)/u.test(intent.reason);
}

function worktreeDeliveryPolicy(intent: WorkspaceIntent): WorkspaceDeliveryPolicy {
  const wantsCandidate = intent.isolationPolicy === 'requested'
    || intent.operation === 'isolated_experiment'
    || intent.originalFilePolicy === 'must_preserve';
  return wantsCandidate ? 'await_acceptance' : 'auto_publish';
}

function isFallbackSafe(intent: WorkspaceIntent): boolean {
  if (intent.isolationPolicy === 'requested' || intent.isolationPolicy === 'required') return false;
  if (intent.isolationPolicy === 'unknown') return false;
  if (intent.originalFilePolicy === 'must_preserve') return false;
  if (intent.originalFilePolicy === 'unknown') return false;
  if (intent.operation === 'isolated_experiment' || intent.operation === 'high_risk_change') return false;
  return IN_PLACE_SAFE_OPERATIONS.has(intent.operation);
}
