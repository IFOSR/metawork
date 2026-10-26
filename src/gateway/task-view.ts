import type {
  TaskOperationPhase,
  TaskPendingAction,
  TaskReason,
  TaskStateSnapshot,
  TaskStatus,
} from '../task/task-state.js';
/**
 * Gateway 只读 Task 视图契约（统一 TUI 设计 §9.3，task_view_v2）。
 *
 * `get_task_view` 命令的安全展示快照 DTO。它是读投影，不生成重复 durable
 * Task/trace 事实；字段全部来自既有 Application 投影 owner
 * （ExecutionProjector / 历史投影 / 权限服务），不复制第二套状态计算。
 *
 * 纯协议模块：只 import type，不依赖 repository / socket / planner / kernel /
 * executor 运行实现。
 */

import type { ExecutionTimeline } from '../management/execution-projector.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';

/**
 * v2: the Task conclusion is the six-state snapshot. Clients read
 * `state.status` / `state.reason` / `state.stateVersion` and never derive a
 * status from logs or from a raw column.
 */
export const GATEWAY_TASK_VIEW_QUERY_VERSION = 'task_view_v2';
export const GATEWAY_COMMAND_COMPLETION_QUERY_VERSION = 'command_completion_v1';

/** Task 快照水位：属于目标 Conversation 事件流的 sequence。 */
export interface GatewayTaskViewSnapshot {
  readonly queryVersion: typeof GATEWAY_TASK_VIEW_QUERY_VERSION;
  /** 回显触发本次查询的 requestId。 */
  readonly requestId: string;
  /** 逻辑目标 Conversation；运输流 ID 不能当作 Conversation ID。 */
  readonly targetConversationId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly title: string;
  /** The one committed Task conclusion (six states). */
  readonly status: TaskStatus;
  /** The whole current Task snapshot, including its version. */
  readonly state: TaskStateSnapshot;
  readonly lifecycle: GatewayTaskViewLifecycle;
  readonly goal: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** 公开路由显示值；不可安全公开时整体为 null，不补零不猜测。 */
  readonly routing: GatewayTaskViewRouting | null;
  readonly subtasks: GatewayTaskViewSubtask[];
  /** 复用 ExecutionProjector 的执行时间线；无法投影时为 null。 */
  readonly timeline: ExecutionTimeline | null;
  /** 最近有效进展摘要；没有安全字段时为 null，UI 显示“暂无信息”。 */
  readonly progressSummary: string | null;
  readonly schedulingReason?: string | null;
  readonly pendingPermission: GatewayTaskViewPermission | null;
  readonly artifacts: ArtifactProjection[];
  readonly result: GatewayTaskViewResult | null;
  readonly publicDelivery?: {
    workspace: string;
    taskDirectory: string | null;
    mode: 'in_place';
    /** Admission fact that authorized the mode. */
    modeSource: 'explicit_user' | 'planner' | 'fallback' | 'kernel_safety' | null;
    deliveryPolicy: 'none' | 'auto_publish' | 'await_acceptance' | null;
    state: 'not_published' | 'awaiting_acceptance' | 'publishing' | 'published' | 'failed';
    /** Retained as a stable empty projection for older clients. */
    candidate: 'none';
    files: string[];
    conflicts: string[];
    stateLabel: string;
  } | null;
  /** Latest observed round changes (bounded); never a completion certification. */
  readonly workspaceChanges?: {
    recordId: string;
    coverage: 'complete' | 'partial' | 'unavailable';
    missingReasons: string[];
    totalFiles: number;
    recordedAt: string;
    files: Array<{ path: string; added: number; deleted: number; binary?: boolean; scratch?: boolean }>;
  } | null;
  /** 快照水位，属于目标 Conversation 的事件流。 */
  readonly asOfSequence: number;
}

export interface GatewayTaskViewRouting {
  readonly executor: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly harness: string | null;
}

/**
 * 统一 TaskView 投影的 wire 形态。字段来自 `projectTaskView`，不复制第二套
 * 状态计算；客户端只解释 phase 与 nextAuthorizedAction。
 */
export interface GatewayTaskViewLifecycle {
  readonly status: TaskStatus;
  readonly statusLabel: string;
  readonly stateVersion: number;
  readonly phase: TaskOperationPhase | null;
  readonly reason: TaskReason;
  readonly pendingActions: readonly TaskPendingAction[];
  readonly cleanup: TaskStateSnapshot['cleanup'];
  /** Active Work Graph generation; per-Turn controls must target it exactly. */
  readonly executionGeneration?: string | null;
  readonly activeAttempt: {
    readonly attemptId: string;
    readonly subtaskId: string;
    readonly kind: string;
    readonly ordinal: number;
    readonly lifecycle: string;
    readonly outcome: string | null;
  } | null;
  readonly blockingResidue: readonly string[];
  readonly nextAuthorizedAction: string;
  /** Why recovery was reached, so a surface can offer the entry point. */
  readonly recoveryDiagnosis: string | null;
  readonly explanation: string;
  readonly lastProgressAt: string | null;
  readonly lastAttemptSettledAt: string | null;
  readonly nextWakeAt: string | null;
}

export interface GatewayTaskViewSubtask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly executor: string | null;
}

export interface GatewayTaskViewPermission {
  readonly requestId: string;
  /** Optimistic-concurrency revision the approval must target. */
  readonly requestRevision?: string;
  readonly generationId?: string;
  readonly status: 'pending' | 'resolved' | 'expired';
  readonly summary: string | null;
}

export interface GatewayTaskViewResult {
  readonly resultId: string;
  readonly completeness: 'complete' | 'partial' | 'incomplete';
  readonly certification: 'certified' | 'uncertified';
}

/** get_task_view 的结构化错误原因码。 */
export type GatewayTaskViewError =
  | 'conversation_not_found'
  | 'turn_not_found'
  | 'task_not_found'
  | 'turn_task_mismatch'
  | 'task_view_unavailable';

/** command_completion 响应 payload（command_completion_v1）。 */
export interface GatewayCommandCompletionPayload {
  readonly queryVersion: typeof GATEWAY_COMMAND_COMPLETION_QUERY_VERSION;
  readonly requestId: string;
  /** Workspace 补全为 null；Conversation 补全回显目标 ID。 */
  readonly targetConversationId: string | null;
  readonly state: 'inactive' | 'incomplete' | 'executable' | 'invalid';
  readonly suggestions: GatewayCommandSuggestion[];
  readonly hint: string | null;
  readonly error: string | null;
}

export interface GatewayCommandSuggestion {
  readonly value: string;
  readonly label: string;
  readonly description: string;
  readonly replacement: {
    readonly start: number;
    readonly end: number;
    readonly text: string;
  };
}
