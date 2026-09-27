import type {
  ExecutionTimeline,
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './types';

export type QueryBillState = 'collecting' | 'pending_reconciliation' | 'finalized';
export type QueryBillExternalState =
  | 'not_exported' | 'pending' | 'received' | 'confirmed' | 'unknown' | 'rejected';
export type QueryBillCoverage = 'complete' | 'partial' | 'incomplete' | 'unavailable';
export type QueryBillPayer = 'platform' | 'user_direct' | 'system' | 'unknown';
/** 用户可见账单状态：最多三种（账单简化设计 §2）。 */
export type QueryBillUserStatus = 'billed' | 'unconfirmed' | 'no_charge';
export type BillingDiagnosticCode =
  | 'no_usage_observed'
  | 'provider_usage_unavailable'
  | 'usage_parser_no_match'
  | 'query_not_finalized'
  | 'missing_price_book'
  | 'missing_price_rule'
  | 'payer_unknown'
  | 'missing_billing_projection'
  | 'historical_unavailable'
  | 'external_consumption_disabled';

export const BILLING_DIAGNOSTIC_MESSAGES: Record<BillingDiagnosticCode, string> = {
  no_usage_observed: 'Provider 未返回可验证的用量数据',
  provider_usage_unavailable: '当前 Provider 不提供用量数据',
  usage_parser_no_match: '收到了 Provider 输出，但没有匹配到 usage 格式',
  query_not_finalized: '请求仍在等待计量收束',
  missing_price_book: '当前请求缺少有效价格规则',
  missing_price_rule: '已记录 Token，但没有匹配到该 Provider/Model 的输入或输出单价',
  payer_unknown: '已记录 Token，但没有确认本次调用由谁承担费用',
  missing_billing_projection: '账单事实存在，但页面投影暂时不可用',
  historical_unavailable: '历史任务没有足够事实，无法安全补算',
  external_consumption_disabled: '本地账单已生成，但外部消费提交未启用',
};

export const BILLING_STATUS_LABELS: Record<QueryBillUserStatus, string> = {
  billed: '已计费',
  unconfirmed: '待确认',
  no_charge: '无费用',
};

export interface QueryBillProjection {
  billId: string;
  queryId: string;
  taskId: string | null;
  turnId?: string | null;
  conversationId?: string | null;
  createdAt?: string;
  priceBookVersion?: string;
  feePolicyVersion?: string;
  state: QueryBillState;
  userStatus?: QueryBillUserStatus;
  assessedMicroCoin: string;
  assessedMetaCoin?: string;
  assessedIsFinal: boolean;
  externalState: QueryBillExternalState;
  externalEntryId: string | null;
  confirmedDeductedMicroCoin: string | null;
  confirmedDeductedMetaCoin?: string | null;
  coverage: QueryBillCoverage;
  coverageNote: string | null;
  platformAbsorption: boolean | Record<string, unknown> | null;
  lines: Array<{
    stage: string | null;
    amountMicroCoin: string;
    amountMetaCoin?: string;
    rationale: string;
  }>;
  adjustments: Array<{
    adjustmentId: string;
    amountMicroCoin: string;
    amountMetaCoin?: string;
    reason: string;
    externalState: QueryBillExternalState;
  }>;
  finalizedAt: string | null;
  diagnosticCode?: BillingDiagnosticCode | null;
  diagnosticMessage?: string | null;
  observedUsageCount?: number;
  missingCategories?: readonly string[];
  usageBreakdown?: Array<{
    agentClassRef: string | null;
    providerRef: string | null;
    modelId: string | null;
    inputTokens: string;
    outputTokens: string;
    cacheReadTokens: string;
    cacheWriteTokens: string;
    totalTokens: string;
  }>;
  stageBreakdown?: Array<{
    stage: string | null;
    agentClassRef: string | null;
    providerRef: string | null;
    modelId: string | null;
    inputTokens: string;
    outputTokens: string;
    cacheReadTokens: string;
    cacheWriteTokens: string;
    totalTokens: string;
    assessedMicroCoin: string | null;
    assessedMetaCoin: string | null;
    costStatus: 'calculated' | 'not_chargeable' | 'pending';
    costReason: string | null;
  }>;
}

/** 单 Turn 三态账单用户视图；金额与状态全部由 Server 投影。 */
export interface TurnBillUserView {
  turnId: string;
  queryId: string | null;
  conversationId: string | null;
  taskId: string | null;
  userStatus: QueryBillUserStatus;
  headline: string;
  amountMicroCoin: string | null;
  amountIsFinal: boolean;
  diagnosticCode: BillingDiagnosticCode | null;
  diagnosticMessage: string | null;
  observedUsageCount: number;
  missingCategories: readonly string[];
  usageBreakdown: NonNullable<QueryBillProjection['usageBreakdown']>;
  stageBreakdown: NonNullable<QueryBillProjection['stageBreakdown']>;
  billId: string | null;
  finalizedAt: string | null;
  projectedAt: string;
}

/** 账单页列表行（Server 投影 + 会话目录联合）。 */
export interface BillingRecordView {
  bill: QueryBillProjection;
  requestSummary: string | null;
  taskTitle: string | null;
  providerDisplayName?: string | null;
  modelDisplayName?: string | null;
}

export type BillingStatusFilter = 'all' | QueryBillUserStatus;

export interface BillingRecordPageView {
  items: BillingRecordView[];
  nextCursor: string | null;
}

export interface TaskBillingDetailView {
  taskId: string;
  taskTitle: string | null;
  items: BillingRecordView[];
}

export interface BillingTaskView {
  taskId: string;
  taskTitle: string;
  queryCount: number;
}

export interface TaskUsageSummary {
  taskId: string;
  finalizedMicroCoin: string;
  pendingReconciliationMicroCoin: string;
  inFlightMicroCoin: string;
  queryCount: number;
  confirmedDeductedMicroCoin: string;
}

export const WEB_SESSION_FORMAT_VERSION = 1 as const;
export const MAX_WEB_SESSION_TURNS = 100;
export const MAX_WEB_SESSION_EVENTS_PER_TURN = 400;

export type WebSessionAvailability = 'active' | 'browsable' | 'activation_blocked';
export type ConversationTurnStatus = Exclude<InteractionTraceStatus, 'running'>;

export type WebSessionActivationBlockReason =
  | 'planner_turn_active'
  | 'task_runtime_active'
  | 'session_unavailable';

export interface WorkspaceSummary {
  id: string;
  accountId: string;
  displayName: string;
  canonicalPath: string;
  availability: 'available' | 'unavailable';
  createdAt: string;
  updatedAt: string;
  createdByPrincipal: string;
  archived: boolean;
}

export interface ConversationActivityProjection {
  state: 'idle' | 'planning' | 'executing' | 'waiting' | 'blocked';
  taskId: string | null;
  updatedAt: string;
}

export interface WebSessionMetadata {
  id: string;
  workspaceId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  archived: boolean;
  preview?: string;
  activity?: ConversationActivityProjection;
  workspace: ConversationWorkspaceProjection | null;
}

export interface ConversationWorkspaceProjection {
  path: string;
  selectedAt: string;
}

export interface ArtifactProjection {
  artifactId: string;
  taskId: string;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  mediaType: string;
  previewKind: 'markdown' | 'text' | 'code' | 'image' | 'unsupported';
  previewable: boolean;
  byteLength: number;
  contentHash: string;
  publishedAt: string;
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
  queryBill?: QueryBillProjection | null;
  taskUsageSummary?: TaskUsageSummary | null;
  turnBilling?: TurnBillUserView | null;
}

export interface ConversationTurnProjection
  extends Omit<ConversationTurn, 'status'> {
  status: InteractionTraceStatus;
}

export interface WebSessionRecord {
  historyCursor?: string | null;
  version: typeof WEB_SESSION_FORMAT_VERSION;
  session: WebSessionMetadata;
  turns: ConversationTurn[];
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
  session: WebSessionRecord;
  activation: WebSessionActivationResult;
}

export interface AttachmentMetadata {
  attachmentId: string;
  accountId: string;
  conversationId: string;
  workspaceId: string;
  name: string;
  mime: string;
  mediaClass: 'image' | 'text' | 'document' | 'archive' | 'binary' | 'unknown';
  /** Legacy projection retained for older persisted client state. */
  kind?: 'image' | 'text' | 'file';
  size: number;
  sha256: string;
  status: 'available' | 'unavailable';
  createdAt: string;
}
