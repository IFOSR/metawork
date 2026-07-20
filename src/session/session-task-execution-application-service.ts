import type { RecallReviewApplicationService } from '../memory/recall-review-application-service.js';
import type { ExecutionRecallSelection } from '../memory/memory-context-service.js';
import type { GuidanceActionType, Task } from '../core/types.js';
import type { TaskRuntimeService } from '../task/task-runtime-service.js';
import type { QueuedExecutionRequest } from './session-helpers.js';
import type { KernelExecutionRuntime } from './session-execution-coordinator.js';
import type { SessionPresentationService } from './session-presentation-service.js';

export interface SessionTaskExecutionApplicationDeps {
  taskRuntimeService: TaskRuntimeService;
  recallReviewApplicationService: RecallReviewApplicationService;
  kernelExecutionRuntime: KernelExecutionRuntime;
  presentation: SessionPresentationService;
  callbacks: {
    appendOutput(...lines: string[]): void;
    appendGuidance(scene: string, suggestion: { taskId: string; recommendedAction: string; reasons: string[] }): void;
    refreshRuntimeState(): void;
  };
}

/** Prepares recall context, then hands an execution request to the Kernel control loop. */
export class SessionTaskExecutionApplicationService {
  private readonly approvedRecallSelections = new Map<string, ExecutionRecallSelection>();

  constructor(private readonly deps: SessionTaskExecutionApplicationDeps) {}

  async prepareTaskExecution(
    taskId: string,
    request: QueuedExecutionRequest,
    proposalType: GuidanceActionType | null = null,
  ): Promise<void> {
    const task = this.deps.taskRuntimeService.findTask(taskId);
    if (!task) {
      this.deps.callbacks.appendOutput(`Task not found: ${taskId}`);
      return;
    }
    const recall = await this.deps.recallReviewApplicationService.apply({
      taskId,
      userPrompt: request.userPrompt,
      taskTitle: task.title,
      proposalType,
    });
    this.approvedRecallSelections.set(taskId, recall.approvedSelection);
    this.deps.callbacks.appendOutput(...recall.lines);
    this.appendExecutionGuidance(task, request);
    const approvedRecallSelection = this.approvedRecallSelections.get(taskId) ?? null;
    this.approvedRecallSelections.delete(taskId);
    await this.deps.kernelExecutionRuntime.execute({ taskId, request, approvedRecallSelection });
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
