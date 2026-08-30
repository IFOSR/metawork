import type { Task } from '../core/types.js';
import type { KernelDecision } from '../kernel/control-kernel.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { KernelExecutionRuntime } from '../execution/kernel-execution-runtime.js';
import type { SessionPresentationService } from './session-presentation-service.js';

export interface SessionTaskExecutionApplicationDeps {
  taskRuntimeService: TaskRuntimeService;
  kernelExecutionRuntime: KernelExecutionRuntime;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    appendGuidance(scene: string, suggestion: { taskId: string; recommendedAction: string; reasons: string[] }): void;
    refreshRuntimeState(): void;
    startBackgroundExecution(taskId: string, launch: () => Promise<void>): Promise<void>;
  };
}

export interface TaskExecutionStart {
  decision: Promise<KernelDecision | null>;
  completion: Promise<void>;
}

export function formatTaskResumeDecision(taskId: string, decision: KernelDecision): string {
  if (decision.action.type === 'resume_task') {
    return `任务 #${taskId} 已获 Kernel 授权，恢复执行已开始`;
  }
  const explanation = resumeDecisionExplanation(decision);
  return `任务 #${taskId} 未重新执行：${explanation}（Kernel: ${decision.reason}）`;
}

function resumeDecisionExplanation(decision: KernelDecision): string {
  if (decision.reason === 'running Task has no exact recoverable Subtask') {
    return '当前任务没有可安全恢复的精确 Subtask，未启动新的 Executor';
  }
  if (decision.reason === 'resume has no recoverable Subtask') {
    return '当前任务没有可恢复的 Subtask，未启动新的 Executor';
  }
  if (decision.reason === 'resume target is not an active recoverable Task') {
    return '目标任务不处于可恢复状态，未启动新的 Executor';
  }
  if (decision.action.type === 'block_work') {
    return '阻塞条件尚未解决，未启动新的 Executor';
  }
  if (decision.action.type === 'park_for_replan') {
    return '当前 Work Graph 需要重新规划，未直接启动 Executor';
  }
  return 'Kernel 未授权恢复执行，未启动新的 Executor';
}

/** Hands an execution request to the Kernel control loop. */
export class SessionTaskExecutionApplicationService {
  constructor(private readonly deps: SessionTaskExecutionApplicationDeps) {}

  prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
  ): TaskExecutionStart {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Task not found: ${taskId}`);
      return {
        decision: Promise.resolve(null),
        completion: Promise.resolve(),
      };
    }
    let resolveDecision!: (decision: KernelDecision | null) => void;
    let decisionSettled = false;
    const decision = new Promise<KernelDecision | null>(resolve => {
      resolveDecision = resolve;
    });
    const prepared = this.deps.kernelExecutionRuntime.prepareExecution({
      taskId,
      request,
      onInitialDecision: value => {
        if (decisionSettled) return;
        decisionSettled = true;
        if (value.action.type === 'resume_task' || value.action.type === 'park_for_replan') {
          this.appendExecutionGuidance(task, request);
        }
        resolveDecision(value);
      },
    });
    const completion = this.deps.callbacks.startBackgroundExecution(
      taskId,
      () => this.deps.kernelExecutionRuntime.execute(prepared),
    ).finally(() => {
      if (decisionSettled) return;
      decisionSettled = true;
      resolveDecision(null);
    });
    return { decision, completion };
  }

  private appendExecutionGuidance(task: Task, request: QueuedExecutionRequest): void {
    if (request.executionMode === 'resume-blocked') {
      this.deps.callbacks.appendGuidance('resume after capacity block', this.deps.presentation.formatBlockedExecutionGuidance(
        task,
        request.newlyProvidedResources,
      ));
    } else if (request.executionMode === 'resume-parked') {
      this.deps.callbacks.appendGuidance('resume parked task', this.deps.presentation.formatResumeExecutionGuidance(task));
    }
  }
}
