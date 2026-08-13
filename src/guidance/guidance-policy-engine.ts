import type { Task } from '../core/types.js';
import type { GuidanceProposal } from '../core/types.js';
import type { TaskSignal } from './task-signal-service.js';

// Guidance renders recovery hints from existing facts only. It must not choose a
// next Task, retry, fallback, preemption, Executor, or Model; those decisions are
// owned by the Kernel admission gate and Runtime dispatch. `prioritize_task` and
// its ready-task ranking are intentionally removed.
interface GuidanceBuildOptions {
  trigger?: string;
  createdAt?: string;
  taskLookup?: Map<string, Pick<Task, 'id' | 'title'>>;
}

export class GuidancePolicyEngine {
  build(signals: TaskSignal[], options: GuidanceBuildOptions = {}): GuidanceProposal[] {
    const createdAt = options.createdAt ?? new Date().toISOString();
    const trigger = options.trigger ?? 'system';
    const taskLookup = options.taskLookup ?? new Map<string, Pick<Task, 'id' | 'title'>>();
    const proposals: GuidanceProposal[] = [];

    for (const signal of signals) {
      if (signal.status === 'parked' && signal.resumability === 'high') {
        proposals.push(
          this.createProposal({
            signal,
            trigger,
            createdAt,
            taskLookup,
            actionType: 'resume_task',
            confidence: this.calculateResumeConfidence(signal),
            reasons: this.buildResumeReasons(signal),
            recommendedAction: `建议恢复任务 #${signal.taskId}: ${this.getTaskLabel(signal.taskId, taskLookup)}`,
          }),
        );
        continue;
      }

      if (signal.status === 'blocked' && signal.hasNewMaterials) {
        proposals.push(
          this.createProposal({
            signal,
            trigger,
            createdAt,
            taskLookup,
            actionType: 'unblock_and_resume',
            confidence: 0.82,
            reasons: ['检测到新的输入材料，可重新判断是否解除阻塞'],
            recommendedAction: `建议检查并恢复任务 #${signal.taskId}: ${this.getTaskLabel(signal.taskId, taskLookup)}`,
          }),
        );
      }
    }

    return proposals.sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      if (left.taskId === right.taskId) {
        return left.actionType.localeCompare(right.actionType);
      }

      return (left.taskId ?? '').localeCompare(right.taskId ?? '');
    });
  }

  private calculateResumeConfidence(signal: TaskSignal): number {
    let confidence = 0.75;
    if (/抢占/.test(signal.lastInterruptionReason)) {
      confidence += 0.1;
    }
    if (signal.progressRatio >= 0.5) {
      confidence += 0.05;
    }
    if (signal.isReady) {
      confidence += 0.05;
    }

    return Math.min(0.95, confidence);
  }

  private buildResumeReasons(signal: TaskSignal): string[] {
    const reasons: string[] = [];

    if (/抢占/.test(signal.lastInterruptionReason)) {
      reasons.push('刚被更高优任务打断，恢复连续性收益最高');
    }
    if (signal.progressRatio >= 0.5) {
      reasons.push(`已完成 ${Math.round(signal.progressRatio * 100)}%，继续成本更低`);
    }
    if (signal.isReady) {
      reasons.push('当前任务输入已齐全');
    }

    return reasons.length > 0 ? reasons : ['具备继续推进条件'];
  }

  private createProposal(input: {
    signal: TaskSignal;
    trigger: string;
    createdAt: string;
    taskLookup: Map<string, Pick<Task, 'id' | 'title'>>;
    actionType: GuidanceProposal['actionType'];
    confidence: number;
    reasons: string[];
    recommendedAction: string;
  }): GuidanceProposal {
    return {
      id: `${input.trigger}:${input.actionType}:${input.signal.taskId}`,
      trigger: input.trigger,
      taskId: input.signal.taskId,
      actionType: input.actionType,
      recommendedAction: input.recommendedAction,
      reasons: input.reasons,
      confidence: input.confidence,
      requiresConfirmation: false,
      proposalPayload: {
        taskId: input.signal.taskId,
        source: input.trigger,
      },
      expiresAt: null,
      createdAt: input.createdAt,
    };
  }

  private getTaskLabel(taskId: string, taskLookup: Map<string, Pick<Task, 'id' | 'title'>>): string {
    return taskLookup.get(taskId)?.title ?? taskId;
  }
}
