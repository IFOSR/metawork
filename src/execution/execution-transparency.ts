/**
 * 执行透明化投影助手（Web Workspace 落地方案 Task 6 / §3.5）。
 *
 * 把 Kernel 已授权 binding 投影为用户可读的 Executor/Harness/Provider/Model
 * 名称与规范化步骤事实。只输出安全的显示字段：不包含命令、日志、prompt、
 * 隐藏思维链、binding fingerprint 或内部 revision。
 */

import type { PublicRoutingIdentity } from '../configuration/public-routing-identity.js';

export interface ExecutorDisplayFacts {
  subtaskId: string;
  subtaskTitle: string;
  executorDisplayName: string;
  harnessDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
}

export interface ExecutionStepFacts {
  stepKey: string;
  stepLabel: string;
  stepIndex?: number;
  stepTotal?: number;
  progress?: number | null;
}

export function buildExecutorDisplayFacts(input: {
  identity: PublicRoutingIdentity;
  subtaskId: string;
  subtaskTitle?: string;
}): ExecutorDisplayFacts {
  return {
    subtaskId: input.subtaskId,
    subtaskTitle: input.subtaskTitle ?? input.subtaskId,
    executorDisplayName: input.identity.executorDisplayName,
    harnessDisplayName: input.identity.harnessDisplayName,
    providerDisplayName: input.identity.providerDisplayName,
    modelDisplayName: input.identity.modelDisplayName,
  };
}

/** 规范化执行里程碑事件 details 的公共字段（§3.5）。 */
export function executionEventDetails(input: {
  display: ExecutorDisplayFacts;
  step: ExecutionStepFacts;
  startedAt?: string;
  updatedAt?: string;
}): Record<string, unknown> {
  return {
    subtaskId: input.display.subtaskId,
    subtaskTitle: input.display.subtaskTitle,
    executorDisplayName: input.display.executorDisplayName,
    harnessDisplayName: input.display.harnessDisplayName,
    providerDisplayName: input.display.providerDisplayName,
    modelDisplayName: input.display.modelDisplayName,
    stepKey: input.step.stepKey,
    stepLabel: input.step.stepLabel,
    ...(input.step.stepIndex !== undefined ? { stepIndex: input.step.stepIndex } : {}),
    ...(input.step.stepTotal !== undefined ? { stepTotal: input.step.stepTotal } : {}),
    // 没有可靠进度百分比时使用 null，不伪造百分比。
    progress: input.step.progress ?? null,
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}
