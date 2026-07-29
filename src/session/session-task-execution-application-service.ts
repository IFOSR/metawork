import type { Task } from '../core/types.js';
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
  };
}

/** Hands an execution request to the Kernel control loop. */
export class SessionTaskExecutionApplicationService {
  constructor(private readonly deps: SessionTaskExecutionApplicationDeps) {}

  async prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
  ): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Task not found: ${taskId}`);
      return;
    }
    this.appendExecutionGuidance(task, request);
    await this.deps.kernelExecutionRuntime.execute({ taskId, request });
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
