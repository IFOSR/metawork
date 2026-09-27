import type { ExecutionTimeline } from './execution-projector.js';
import type {
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './interaction-trace.js';
import type {
  ConversationTurnProjection,
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionDirectoryMetadata,
  WebSessionDirectoryMetadataProjection,
  WebSessionRecord,
  WebSessionRecordProjection,
  WorkspaceInitializationResult,
} from './web-session-types.js';
import type { WorkspaceSummary } from '../workspace/workspace-directory-service.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import type { BillQueryService } from '../billing/bill-query-service.js';

export interface WebDirectoryPage<T = WebSessionDirectoryMetadataProjection> {
  items: T[];
  nextCursor: string | null;
  projectionVersion?: number;
}

export interface WebSessionRuntimeCatalog {
  readMetadata?(sessionId: string): Promise<(WebSessionRecord['session'] & { workspaceId: string | null }) | null>;
  readVersion?(sessionId: string): Promise<string | null>;
  listPage?(input: {
    workspaceId: string; principalId: string; activeConversationId?: string | null;
    query?: string; cursor?: string;
  }): Promise<WebDirectoryPage<WebSessionDirectoryMetadata>>;
  initialize(): Promise<void>;
  create(input: { workspaceId: string; principalId: string }): Promise<WebSessionRecord>;
  list(input: {
    workspaceId: string;
    principalId: string;
    activeConversationId?: string | null;
    query?: string;
  }): Promise<WebSessionDirectoryMetadata[]>;
  search(input: {
    workspaceId: string;
    principalId: string;
    activeConversationId?: string | null;
    query?: string;
  }): Promise<WebSessionDirectoryMetadata[]>;
  read(sessionId: string, activeConversationId?: string | null): Promise<WebSessionRecord | null>;
  readPage?(
    sessionId: string, activeConversationId?: string | null,
    request?: import('../session/conversation-history-store.js').ConversationHistoryRequest,
  ): Promise<WebSessionRecord | null>;
  workspaceIdForConversation(sessionId: string): Promise<string | null>;
  listWorkspaces(principalId: string): Promise<WorkspaceSummary[]>;
  archive(sessionId: string, workspaceId: string, principalId: string): Promise<boolean>;
  clearWorkspace(workspaceId: string, principalId: string, exceptId?: string): Promise<number>;
  appendTurn(sessionId: string, turn: import('./web-session-types.js').ConversationTurn): Promise<unknown>;
}

export type WebSessionRuntimeEvent =
  | {
    type: 'workspace_conversation_changed';
    workspaceId: string;
    conversationId: string;
    removed?: boolean;
    changes?: Partial<WebSessionDirectoryMetadataProjection>;
  }
  | { type: 'active_session_changed'; sessionId: string }
  | {
    type: 'session_catalog';
    activeSessionId: string;
    sessions: WebSessionDirectoryMetadataProjection[];
    nextCursor?: string | null;
  }
  | {
    type: 'workspace_directory';
    activeWorkspaceId: string;
    activeSessionId: string | null;
    sessions: WebSessionDirectoryMetadataProjection[];
    nextCursor?: string | null;
  }
  | { type: 'output'; from: number; lines: string[] }
  | {
    type: 'turn_started';
    requestId: string;
    turnId: string;
    userInput: string;
    startedAt: string;
    interactionKind?: 'system_command' | 'ai_turn';
  }
  | {
    type: 'final_answer';
    requestId: string;
    turnId: string;
    lines: string[];
    completedAt: string;
    backgroundWorkPending?: boolean;
  }
  | {
    type: 'terminal_error';
    requestId: string;
    turnId: string;
    message: string;
    completedAt: string;
  }
  | {
    type: 'result_delivery_available';
    requestId: string;
    turnId: string;
    resultId: string;
    contentHash: string;
    byteLength: number;
    completeness: 'complete' | 'partial' | 'incomplete';
    certification: 'certified' | 'uncertified';
  }
  | {
    type: 'result_chunk';
    requestId: string;
    turnId: string;
    resultId: string;
    offset: number;
    chunk: string;
  }
  | {
    type: 'result_completed';
    requestId: string;
    turnId: string;
    resultId: string;
    content: string;
    contentHash: string;
    byteLength: number;
    completeness: 'complete' | 'partial' | 'incomplete';
    certification: 'certified' | 'uncertified';
  }
  | {
    type: 'trace_delta';
    turnId: string;
    fromSequence: number;
    events: InteractionTraceEvent[];
    status?: InteractionTraceStatus;
    completedAt?: string | null;
  }
  | {
    type: 'execution';
    turnId: string;
    taskId: string;
    timeline: ExecutionTimeline;
  }
  | {
    type: 'artifacts';
    turnId: string;
    taskId: string;
    artifacts: ArtifactProjection[];
  }
  | {
    type: 'billing';
    turnId: string;
    queryBill: import('../billing/bill-query-service.js').QueryBillProjection | null;
    taskUsageSummary: import('../billing/bill-query-service.js').TaskUsageSummary | null;
    turnBilling: import('../billing/bill-query-service.js').TurnBillUserView | null;
  }
  | { type: 'conversation_snapshot'; turn: ConversationTurnProjection }
  | {
    type: 'workspace_changed';
    sessionId: string;
    workspace: import('./web-session-types.js').ConversationWorkspaceProjection | null;
  };

export interface ManagementWebSessionRuntime {
  initialize(): Promise<void>;
  closeClient(clientId: string): Promise<void>;
  dispose(): Promise<void>;
  getClientState(clientId: string): {
    activeWorkspaceId: string | null;
    activeSessionId: string | null;
  };
  listWorkspaces(clientId: string): Promise<WorkspaceSummary[]>;
  selectWorkspace(clientId: string, path: string): Promise<WorkspaceInitializationResult>;
  submit(
    clientId: string,
    text: string,
    attachments?: Array<{ attachmentId: string; kind: string }>,
    requestId?: string,
  ): Promise<void>;
  /** Cancels the Client's current turn (Planner run and/or its Task). */
  cancelTurn(clientId: string, turnId: string): Promise<void>;
  listSessions(clientId: string, query?: string): Promise<WebSessionDirectoryMetadataProjection[]>;
  listSessionPage?(clientId: string, input?: { query?: string; cursor?: string }): Promise<WebDirectoryPage>;
  readSession(clientId: string, sessionId: string, cursor?: string): Promise<WebSessionRecordProjection | null>;
  createSession(clientId: string): Promise<WebSessionCreationResult>;
  activateSession(clientId: string, sessionId: string, expectedWorkspaceId?: string): Promise<WebSessionActivationResult>;
  /** 硬删除历史会话；活跃会话拒绝删除。 */
  deleteSession(clientId: string, sessionId: string): Promise<'deleted' | 'not_found' | 'active'>;
  /** 清空除活跃外的全部会话，返回删除数量。 */
  clearAllSessions(clientId: string): Promise<{ deleted: number }>;
  subscribe(clientId: string, listener: (event: WebSessionRuntimeEvent) => void): () => void;
  getReplayEvents(clientId: string): WebSessionRuntimeEvent[];
  /**
   * 只读账单页：分页历史账单 + 会话目录联合出的请求摘要/Task 标题。
   * 不创建 Turn，不改变账单状态，金额与状态全部来自 Server 投影。
   */
  listBillingRecords(
    clientId: string,
    input?: {
      readonly cursor?: string;
      readonly filter?: import('./web-session-types.js').BillingStatusFilter;
      readonly limit?: number;
    },
  ): Promise<import('./web-session-types.js').BillingRecordPageView>;
  /** Task 详情的关联 Query 展示；无事实时返回空 items，由页面显示未建立计量记录。 */
  getTaskBillingDetail(
    clientId: string,
    taskId: string,
  ): Promise<import('./web-session-types.js').TaskBillingDetailView | null>;
  listBillingTasks?(
    clientId: string,
  ): Promise<readonly import('./web-session-types.js').BillingTaskView[]>;
}
