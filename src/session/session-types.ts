/**
 * Session 展示类型（ADR-0031 第 2 节）。
 *
 * 从 MetaclawSession 解耦出的只读展示投影类型。这些类型被 Web
 * 管理、Feishu、Gateway 适配器等传输层引用，不依赖具体 Session 实现类。
 */

import type { RuntimeState, Task } from '../core/types.js';
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
