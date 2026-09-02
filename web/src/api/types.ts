// 与 src/management/ 投影类型同构的前端类型。初期手动同步。

export type StagePhase = 'planning' | 'authorization' | 'execution' | 'verification' | 'delivery';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface TimelineStage {
  phase: StagePhase;
  status: StageStatus;
  proposal?: {
    subtasks: string[];
    dependencies: string[][];
  };
  decisions?: Array<{
    type: string;
    subtask: string;
    reason: string;
  }>;
  subtasks?: SubtaskCard[];
}

export interface SubtaskCard {
  id: string;
  title: string;
  status: string;
  executor?: string;
  attempts: Array<{
    attemptId?: string;
    attemptKind: 'primary' | 'continuation' | 'fallback' | 'contract_correction' | 'merge_repair';
    attemptOrdinal: number;
    attemptLabel: string;
    displayStatus: '等待启动' | '执行中' | '已完成' | '失败' | '已取消' | '状态未知';
    result: string;
    status?: string;
    startedAt?: string;
    updatedAt?: string;
    exitCode?: number;
    error?: string;
    progress?: Record<string, unknown>;
    progressHistory?: Array<{
      kind: string;
      text: string;
      occurredAt: string;
    }>;
  }>;
}

export interface ExecutionTimeline {
  taskId: string;
  title: string;
  status: string;
  stages: TimelineStage[];
}

export interface WorkGraphPresentationProjection {
  generationId: string | null;
  nodes: Array<{
    id: string;
    title: string;
    goal: string;
    status: string;
    phase: number;
    runnable: boolean;
    dependencies: string[];
    requiredCapabilities: string[];
    acceptanceCriteria: string[];
    routing: Array<{
      executorDisplayName: string;
      harnessDisplayName: string;
      policy: 'auto' | 'fixed';
      selected?: {
        providerDisplayName: string;
        modelDisplayName: string;
      };
      estimatedCost?: number;
      estimatedLatencyMs?: number;
      rejectedCandidates: Array<{
        providerDisplayName: string;
        modelDisplayName: string;
        reasonCode: string;
        reasonDetail?: string;
      }>;
    }>;
  }>;
  edges: Array<{ from: string; to: string; kind: 'dependency' | 'handoff' | 'artifact'; label: string }>;
  parallelGroups: string[][];
  currentRunnableFrontier: string[];
}

export type InteractionTraceStatus = 'running' | 'completed' | 'failed' | 'blocked';

export interface InteractionTraceEvent {
  id: string;
  sequence: number;
  occurredAt: string;
  phase: 'intake' | 'planning' | 'authorization' | 'routing' | 'execution' | 'verification' | 'delivery';
  actor: 'user' | 'planner' | 'kernel' | 'runtime' | 'executor';
  kind: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  title: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface InteractionTrace {
  sessionId: string;
  turnId: string;
  taskId: string | null;
  status: InteractionTraceStatus;
  startedAt: string;
  completedAt: string | null;
  events: InteractionTraceEvent[];
}

export interface ConfigSnapshot {
  revisionId: string;
  runningRevisionId: string;
  activeRevisionId?: string;
  runtimeRevisionId?: string;
  activationStatus?: 'idle' | 'busy' | 'activating';
  activationAllowed?: boolean;
  blockingReasons?: Array<{ code: string; message: string; taskId?: string; count?: number }>;
  activeTaskId?: string | null;
  activeAttemptCount?: number;
  plannerTurnActive?: boolean;
  hotActivationSupported?: boolean;
  restartRequired?: boolean;
  checkedAt?: string;
  contentHash: string;
  // AnyFusionConfigurationV2；第 5 步补全精确类型。
  config: Record<string, unknown>;
}

export type ConfigurationCompletionFieldState =
  | '已自动发现'
  | '已从 Provider 补全'
  | '已从本机 Agent 导入'
  | '需要确认'
  | '缺失';

export interface ConfigurationCompletionResult {
  providers: Record<string, {
    displayName: string;
    baseUrl: string | null;
    credentialState: ConfigurationCompletionFieldState;
    modelIds: string[];
  }>;
  providerPresets: Array<{
    providerRef: string;
    displayName: string;
    baseUrl: string;
    modelIds: string[];
  }>;
  models: Record<string, {
    providerRef: string;
    modelId: string;
    capabilities: string[];
    capabilityState: ConfigurationCompletionFieldState;
    contextLimit?: number;
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
    latencyTier?: string;
    qualityTier?: string;
  }>;
  requiredFields: string[];
}

export type ConfigurationRuntimeState = Pick<ConfigSnapshot,
  'activeRevisionId' | 'runtimeRevisionId' | 'activationStatus' | 'activationAllowed'
  | 'blockingReasons' | 'activeTaskId' | 'activeAttemptCount' | 'plannerTurnActive'
  | 'hotActivationSupported' | 'restartRequired' | 'checkedAt'>;

export interface ExecutorCapabilityManual {
  agentClassRef: string;
  configurationRevision: string;
  sourceFingerprint: string;
  routableCapabilities: string[];
  capabilities: Array<{
    capabilityId: string;
    support: 'supported' | 'unsupported';
    routingDisposition: 'preferred' | 'allowed' | 'avoid' | 'disabled';
    evidence: Array<{
      kind: string;
      modelRef?: string;
      detail: string;
    }>;
    unresolvedReasons: string[];
  }>;
  markdown: string;
  tags: {
    bestFit: string[];
    avoid: string[];
  };
}

export interface ExecutorManualAnalysis {
  agentClassRef: string;
  configurationRevision: string;
  sourceText: string;
  analysisMode: 'semantic' | 'source-preserved';
  warning?: string;
  userProfile: {
    sourceText: string;
    assertionsSourceFingerprint?: string;
    semanticReceipt?: string;
    assertions: Array<{
      topic: string;
      text: string;
      target?: string;
      modelRef?: string;
      modelCapability?: string;
      routingCapability?: string;
      disposition?: 'preferred' | 'allowed' | 'avoid' | 'disabled';
    }>;
  };
  manual: ExecutorCapabilityManual;
  config: Record<string, unknown>;
}

export interface ActivateResult {
  ok: boolean;
  revisionId?: string;
  code?: string;
  activeRevisionId?: string | null;
  runningRevisionId?: string;
  restartRequired?: boolean;
  issues?: string[];
  restartPaths?: string[];
  blockingReasons?: Array<{ code: string; message: string; taskId?: string; count?: number }>;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

export interface ExecutorSummary {
  id: string;
  kind: string;
  enabled: boolean;
  health: string;
}

// WebSocket 消息协议
import type {
  ArtifactProjection,
  ConversationWorkspaceProjection,
  ConversationTurnProjection,
  WebSessionMetadata,
} from './session-types';

export type ServerMessage =
  | { type: 'hello'; sessionId: string | null }
  | {
      type: 'session_catalog';
      activeSessionId: string;
      sessions: WebSessionMetadata[];
    }
  | {
      type: 'workspace_directory';
      activeWorkspaceId: string;
      activeSessionId: string | null;
      sessions: WebSessionMetadata[];
    }
  | { type: 'active_session_changed'; sessionId: string }
  | {
    type: 'workspace_changed';
    sessionId: string;
    workspace: ConversationWorkspaceProjection | null;
  }
  | { type: 'conversation_snapshot'; turn: ConversationTurnProjection }
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
  // from 是 lines[0] 在完整输出中的绝对行号；重连回放 from=0，按下标幂等合并去重。
  | { type: 'output'; from: number; lines: string[] }
  | { type: 'execution'; taskId: string; timeline: ExecutionTimeline }
  | {
    type: 'artifacts';
    turnId: string;
    taskId: string;
    artifacts: ArtifactProjection[];
  }
  | { type: 'trace_snapshot'; trace: InteractionTrace }
  | { type: 'configuration_runtime_state'; state: ConfigurationRuntimeState }
  | {
      type: 'trace_delta';
      turnId: string;
      fromSequence: number;
      events: InteractionTraceEvent[];
      status?: InteractionTraceStatus;
      completedAt?: string | null;
    }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'input'; text: string; attachments?: Array<{ attachmentId: string }> }
  | { type: 'close' };
