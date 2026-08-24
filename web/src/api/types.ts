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
  configurationRevision: string;
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
      agentClassRef: string;
      harnessRef?: string;
      policy: 'auto' | 'fixed';
      providerRef?: string;
      modelRef?: string;
      permissionProfileRef?: string;
      estimatedCost?: number;
      estimatedLatencyMs?: number;
      rejectedCandidates: Array<{ providerRef: string; modelRef: string; reason: string }>;
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
    baseUrl: string | null;
    credentialState: ConfigurationCompletionFieldState;
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
  ConversationTurnProjection,
  WebSessionMetadata,
} from './session-types';

export type ServerMessage =
  | { type: 'hello'; sessionId: string }
  | {
      type: 'session_catalog';
      activeSessionId: string;
      sessions: WebSessionMetadata[];
    }
  | { type: 'active_session_changed'; sessionId: string }
  | { type: 'conversation_snapshot'; turn: ConversationTurnProjection }
  | {
    type: 'turn_started';
    requestId: string;
    turnId: string;
    userInput: string;
    startedAt: string;
  }
  | {
    type: 'final_answer';
    requestId: string;
    turnId: string;
    lines: string[];
    completedAt: string;
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
  | { type: 'trace_snapshot'; trace: InteractionTrace }
  | { type: 'configuration_runtime_state'; state: ConfigurationRuntimeState }
  | {
      type: 'trace_delta';
      turnId: string;
      fromSequence: number;
      events: InteractionTraceEvent[];
    }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'input'; text: string; attachments?: Array<{ attachmentId: string }> }
  | { type: 'close' };
