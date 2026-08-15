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
  }>;
}

export interface ExecutionTimeline {
  taskId: string;
  title: string;
  status: string;
  stages: TimelineStage[];
}

export interface ConfigSnapshot {
  revisionId: string;
  contentHash: string;
  // AnyFusionConfigurationV2；第 5 步补全精确类型。
  config: Record<string, unknown>;
}

export interface ActivateResult {
  ok: boolean;
  revisionId?: string;
  code?: string;
  activeRevisionId?: string | null;
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
export type ServerMessage =
  | { type: 'hello'; sessionId: string }
  | { type: 'output'; lines: string[] }
  | { type: 'execution'; taskId: string; timeline: ExecutionTimeline }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'input'; text: string }
  | { type: 'close' };
