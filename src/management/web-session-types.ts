import type { ExecutionTimeline } from './execution-projector.js';
import type {
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './interaction-trace.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import type {
  BillQueryService,
  QueryBillProjection,
  QueryBillUserStatus,
  TaskUsageSummary,
  TurnBillUserView,
} from '../billing/bill-query-service.js';

export const WEB_SESSION_FORMAT_VERSION = 1 as const;
export const MAX_WEB_SESSION_TURNS = 100;
// Gateway events are individually bounded at 64 KiB. Keep a generous history
// ceiling so Planner/Kernel milestones are not discarded merely because a
// long Executor run produced more than the old 400-event UI suffix.
export const MAX_WEB_SESSION_EVENTS_PER_TURN = 10_000;

export type WebSessionAvailability = 'active' | 'browsable' | 'activation_blocked';
export type ConversationTurnStatus = Exclude<InteractionTraceStatus, 'running'>;

export type WebSessionActivationBlockReason =
  | 'planner_turn_active'
  | 'task_runtime_active'
  | 'session_unavailable';

export interface WebSessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  archived: boolean;
}

export interface WebSessionActivityProjection {
  state: import('../workspace/workspace-conversation-projector.js').ConversationActivityState;
  taskId: string | null;
  updatedAt: string;
}

export interface WebSessionDirectoryMetadata extends WebSessionMetadata {
  workspaceId: string;
  preview: string;
  activity: WebSessionActivityProjection;
}

export interface ConversationWorkspaceProjection {
  path: string;
  selectedAt: string;
}

export interface WebSessionMetadataProjection extends WebSessionMetadata {
  workspaceId: string | null;
  workspace: ConversationWorkspaceProjection | null;
}

export interface WebSessionDirectoryMetadataProjection
  extends WebSessionDirectoryMetadata {
  workspace: ConversationWorkspaceProjection | null;
}

export interface ConversationTurn {
  id: string;
  sessionId: string;
  userInput: string;
  interactionKind?: 'system_command' | 'ai_turn';
  status: ConversationTurnStatus;
  finalAnswer: string | null;
  taskId: string | null;
  startedAt: string;
  completedAt: string | null;
  traceEvents: InteractionTraceEvent[];
  executionTimeline: ExecutionTimeline | null;
  /** 兼容字段：历史客户端继续可用。 */
  artifactRefs: string[];
  /** 受限的用户 artifact projection；不含任何内部路径。 */
  artifacts: ArtifactProjection[];
  /** Server-owned billing projection; the client never calculates amounts. */
  queryBill?: QueryBillProjection | null;
  taskUsageSummary?: TaskUsageSummary | null;
  /**
   * Server-owned 三态账单用户视图（账单简化设计 §3.1）；非系统 Turn 恒有，
   * 无金额时携带稳定诊断。由 enrichTurn 按持久事实重新投影，不信任历史存储。
   */
  turnBilling?: TurnBillUserView | null;
}

/** 账单页列表行：Server 投影 + 会话目录联合出的展示模型。 */
export interface BillingRecordView {
  readonly bill: QueryBillProjection;
  /** 用户请求摘要（来自会话目录的 userInput 单行截断）；非 Web 入口为 null。 */
  readonly requestSummary: string | null;
  readonly taskTitle: string | null;
  readonly providerDisplayName?: string | null;
  readonly modelDisplayName?: string | null;
}

export type BillingStatusFilter = 'all' | QueryBillUserStatus;

export interface BillingRecordPageView {
  readonly items: readonly BillingRecordView[];
  readonly nextCursor: string | null;
}

/** Task 详情的关联请求展示（账单简化设计 §3.3）。 */
export interface TaskBillingDetailView {
  readonly taskId: string;
  readonly taskTitle: string | null;
  readonly items: readonly BillingRecordView[];
}

export interface BillingTaskView {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly queryCount: number;
}

export interface ConversationTurnProjection
  extends Omit<ConversationTurn, 'status'> {
  status: InteractionTraceStatus;
}

export interface WebSessionRecord {
  version: typeof WEB_SESSION_FORMAT_VERSION;
  session: WebSessionMetadata;
  turns: ConversationTurn[];
  /** Opaque cursor for the next older history page, not an array offset. */
  historyCursor?: string | null;
}

export interface WebSessionRecordProjection
  extends Omit<WebSessionRecord, 'session' | 'turns'> {
  session: WebSessionMetadataProjection;
  turns: ConversationTurnProjection[];
}

export type WebSessionActivationResult =
  | { state: 'active'; sessionId: string }
  | { state: 'browsable'; sessionId: string }
  | {
    state: 'activation_blocked';
    sessionId: string;
    reason: WebSessionActivationBlockReason;
  };

export interface WebSessionCreationResult {
  session: WebSessionRecordProjection;
  activation: WebSessionActivationResult;
}

export type WorkspaceInitializationResult =
  | { status: 'not_requested' }
  | {
    status: 'accepted';
    workspace?: import('../workspace/workspace-types.js').WorkspaceRecord;
    conversations?: WebSessionDirectoryMetadataProjection[];
    nextCursor?: string | null;
    projectionVersion?: number;
  }
  | { status: 'failed'; reason: string };

export function boundWebSessionTurns(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.slice(-MAX_WEB_SESSION_TURNS);
}

export function boundConversationTraceEvents(
  events: InteractionTraceEvent[],
): InteractionTraceEvent[] {
  return events.slice(-MAX_WEB_SESSION_EVENTS_PER_TURN);
}
