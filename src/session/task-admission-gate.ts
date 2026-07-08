// Enforces the single-active-top-level-task rule for execution dispatch before
// work reaches the scheduler.
import type { Task } from '../core/types.js';

export interface TaskAdmissionGateResult {
  allowed: boolean;
  lines: string[];
}

interface ExecutionAdmissionInput {
  taskId: string;
  runningTask: Task | null;
}

/** Decides whether an execution request may enter while another top-level task is running. */
export class TaskAdmissionGate {
  evaluateExecution(input: ExecutionAdmissionInput): TaskAdmissionGateResult {
    const { taskId, runningTask } = input;
    if (!runningTask || runningTask.id === taskId) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, `针对 #${taskId} 的执行请求与当前活跃顶层任务冲突`);
  }

  evaluateNewTopLevelTask(runningTask: Task | null, reason: string): TaskAdmissionGateResult {
    if (!runningTask) {
      return allowAdmission();
    }

    return rejectAdmission(runningTask, reason);
  }
}

function allowAdmission(): TaskAdmissionGateResult {
  return { allowed: true, lines: [] };
}

function rejectAdmission(runningTask: Task, reason: string): TaskAdmissionGateResult {
  return {
    allowed: false,
    lines: [
      `→ MetaClaw：单活跃任务限制已拒绝该请求(${reason})。`,
      `→ 当前活跃顶层任务：#${runningTask.id} ${runningTask.title}`,
      '→ 请先查询状态,或完成/取消当前任务,再开始新的顶层任务。',
    ],
  };
}
