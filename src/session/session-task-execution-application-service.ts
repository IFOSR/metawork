import type { Task } from '../core/types.js';
import type { KernelDecision } from '../kernel/control-kernel.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { KernelExecutionRuntime } from '../execution/kernel-execution-runtime.js';
import type { SessionPresentationService } from './session-presentation-service.js';
import type { ExecutionTraceAppendInput } from '../execution/execution-trace.js';
import { isUnknownTaskBlocker } from '../task/task-blocker-guidance.js';

export interface SessionTaskExecutionApplicationDeps {
  taskRuntimeService: TaskRuntimeService;
  kernelExecutionRuntime: KernelExecutionRuntime;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    appendExecutionTrace?(input: ExecutionTraceAppendInput): void;
    appendGuidance(scene: string, suggestion: { taskId: string; recommendedAction: string; reasons: string[] }): void;
    refreshRuntimeState(): void;
    startBackgroundExecution(taskId: string, launch: () => Promise<void>): Promise<void>;
  };
}

export interface TaskExecutionStart {
  decision: Promise<KernelDecision | null>;
  completion: Promise<void>;
}

export function formatTaskResumeDecision(
  taskId: string,
  decision: KernelDecision,
  taskStatus?: Task['status'],
): string {
  if (decision.action.type === 'resume_task') {
    return `任务 #${taskId} 已获 Kernel 授权，等待执行调度；实际启动状态请查看执行轨迹`;
  }
  const explanation = resumeDecisionExplanation(decision, taskStatus);
  return `任务 #${taskId} 未重新执行：${explanation}（Kernel: ${decision.reason}）`;
}

function resumeDecisionExplanation(decision: KernelDecision, taskStatus?: Task['status']): string {
  if (decision.reason === 'running Task has no exact recoverable Subtask') {
    return '当前任务没有可安全恢复的精确 Subtask，未启动新的 Executor';
  }
  if (decision.reason === 'resume has no recoverable Subtask') {
    return '当前任务没有可恢复的 Subtask，未启动新的 Executor';
  }
  if (decision.reason === 'resume target is not an active recoverable Task') {
    const terminalState = taskStatus === 'cancelled'
      ? '该任务已经取消，不能继续恢复'
      : taskStatus && ['done', 'failed', 'archived'].includes(taskStatus)
        ? `该任务已经处于终态（${taskStatus}），不能继续恢复`
        : '该任务已经不处于可恢复状态，不能继续恢复';
    return `目标任务不处于可恢复状态，未启动新的 Executor。${terminalState}；如果还需要执行，请新建任务`;
  }
  if (
    decision.action.type === 'block_work'
    && isUnknownTaskBlocker(decision.reason)
  ) {
    return '上次执行结果不确定，材料齐全也不能证明没有外部副作用；未启动新的 Executor。'
      + `请先执行 /task recovery ${decision.action.taskId} 查看恢复项`;
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
        // Planner-authorized task controls run in the background. Their
        // initial Kernel decision used to stay inside this promise, leaving
        // the user-facing Turn in "preparing" forever when the Kernel
        // correctly returned no_op (for example, a cancelled Task cannot be
        // resumed). Publish the authoritative outcome and close the trace.
        if (
          request.kernelDecisionId
          && (request.executionMode === 'resume-blocked' || request.executionMode === 'resume-parked')
          && value.action.type !== 'resume_task'
        ) {
          const message = formatTaskResumeDecision(task.id, value, task.status);
          this.deps.callbacks.appendOutput(message);
          this.deps.callbacks.appendExecutionTrace?.({
            phase: 'delivery',
            actor: 'runtime',
            kind: 'resume_not_executed',
            status: 'completed',
            title: 'Task resume completed without execution',
            summary: message,
            details: {
              taskId: task.id,
              decisionId: value.id,
              action: value.action.type,
              reason: value.reason,
              executorStarted: false,
            },
            eventKey: `${value.id}:resume_not_executed`,
            taskId: task.id,
            traceStatus: 'completed',
          });
          this.deps.callbacks.refreshRuntimeState();
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
