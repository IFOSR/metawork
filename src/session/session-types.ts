/**
 * Session 展示类型（ADR-0031 第 2 节）。
 *
 * 从 MetaclawSession 解耦出的只读展示投影类型。这些类型被 TUI bridge、Web
 * 管理、Feishu、Gateway 适配器等传输层引用，不依赖具体 Session 实现类。
 */

import type { KernelExecutorStatusProjection } from '../kernel/executor-status-projection.js';
import type { RuntimeState, Subtask, Task } from '../core/types.js';
import type { GuidanceState } from './session-presentation-service.js';

export interface SessionSnapshot {
  output: string[];
  currentTaskId: string | null;
  currentTask: {
    id: string;
    title: string;
    status: Task['status'];
  } | null;
  runtimeState: RuntimeState;
  plannerState: {
    status: 'idle' | 'running';
  };
  latestGuidance: GuidanceState | null;
}

export interface SessionSwitchingState {
  plannerTurnActive: boolean;
  taskRuntimeActive: boolean;
}

/** A bounded, read-only projection for the native Planner TUI bridge. */
export interface PlannerTuiSnapshot {
  schemaVersion: 1;
  session: {
    id: string;
    focusedTask: SessionSnapshot['currentTask'];
    runtimeState: RuntimeState;
    plannerState: SessionSnapshot['plannerState'];
    recentOutput: string[];
  };
  taskPool: Array<{
    id: string;
    title: string;
    goal: string;
    status: Task['status'];
    blockingReason: string | null;
    subtasks: Array<{
      id: string;
      title: string;
      status: Subtask['status'];
      preferredAgentClassList: string[];
    }>;
  }>;
  executorStatuses: KernelExecutorStatusProjection[];
}

/** A durable, presentation-only result projected from an integrated workspace publication. */
export interface PlannerTuiExecutorResult {
  schemaVersion: 1;
  publicationId: string;
  taskId: string;
  taskTitle: string;
  subtaskId: string;
  subtaskTitle: string;
  attemptId: string;
  executorName: string;
  report: string;
  artifacts: string[];
  warnings: string[];
  integrationCommit: string | null;
  completedAt: string;
  reportTruncated: boolean;
}

export interface PlannerTuiPermissionRequest {
  schemaVersion: 1;
  permissionRequestId: string;
  taskId: string;
  taskTitle: string;
  generationId: string;
  subtaskId: string;
  subtaskTitle: string;
  attemptId: string;
  executorName: string;
  permissionProfileId: string;
  capability: string;
  resource: string;
  operation: string;
  reason: string;
  suggestedScope: 'once' | 'attempt';
  escalationReason: string;
  createdAt: string;
  expiresAt: string;
}

export type PlannerTuiPermissionResolutionResult =
  | { status: 'resolved' | 'replayed'; resolution: 'approve' | 'deny'; message: string }
  | { status: 'conflict'; resolution: null; message: string };

export interface PlannerTuiCommandSubmissionResult {
  exitRequested: boolean;
  output: string[];
}
