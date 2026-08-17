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
    result: string;
    exitCode?: number;
    error?: string;
    progress?: Record<string, unknown>;
  }>;
}

export interface ExecutionTimeline {
  taskId: string;
  title: string;
  status: string;
  stages: TimelineStage[];
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
  contentHash: string;
  // AnyFusionConfigurationV2；第 5 步补全精确类型。
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
  // from 是 lines[0] 在完整输出中的绝对行号；重连回放 from=0，按下标幂等合并去重。
  | { type: 'output'; from: number; lines: string[] }
  | { type: 'execution'; taskId: string; timeline: ExecutionTimeline }
  | { type: 'trace_snapshot'; trace: InteractionTrace }
  | {
      type: 'trace_delta';
      turnId: string;
      fromSequence: number;
      events: InteractionTraceEvent[];
    }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'input'; text: string }
  | { type: 'close' };
