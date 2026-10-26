import type { TaskRepo, TaskMetadataChanges } from '../storage/task-repo.js';
import type { TaskEngine } from './task-engine.js';
import type { TaskClearScope } from './task-control-types.js';
import type { Task, TaskStatus } from '../core/types.js';
import type {
  ApplyTaskChangeCommand,
  TaskLifecyclePort,
  TaskStateApplyResult,
} from './task-lifecycle-transition-port.js';

export interface TaskRuntimeServiceDeps {
  taskEngine: TaskEngine;
  taskRepo: TaskRepo;
  /** The single durable Task state entry. */
  lifecyclePort: Pick<TaskLifecyclePort, 'applyTaskChange'>;
}

const CLEAR_SCOPE_STATUSES: Record<TaskClearScope, TaskStatus[]> = {
  all: ['queued', 'running', 'needs_action'],
  parked: ['needs_action'],
  blocked: ['needs_action'],
};

/**
 * Task Domain facade.
 *
 * It owns Task queries, creation and non-lifecycle metadata. It cannot write a
 * Task status by itself: lifecycle writes go through `applyTaskChange()`, which
 * is the only entry and validates the transition, version and facts.
 */
export class TaskRuntimeService {
  constructor(private readonly deps: TaskRuntimeServiceDeps) {}

  listTasks(): Task[] {
    return this.deps.taskEngine.list();
  }

  listTasksByConversation(conversationId: string): Task[] {
    return this.deps.taskRepo.findByConversation(conversationId);
  }

  listActiveTasks(): Task[] {
    return this.deps.taskRepo.findActive();
  }

  listTasksByStatus(status: TaskStatus): Task[] {
    return this.deps.taskRepo.findByStatus(status);
  }

  findTask(taskId: string): Task | null {
    return this.deps.taskRepo.findById(taskId);
  }

  createTask(input: Parameters<TaskEngine['create']>[0]): Task {
    return this.deps.taskEngine.create(input);
  }

  /** Metadata only. Lifecycle fields are rejected at the repository boundary. */
  updateTask(taskId: string, changes: TaskMetadataChanges): Task | null {
    if (!this.findTask(taskId)) return null;
    this.deps.taskRepo.update(taskId, changes);
    return this.findTask(taskId);
  }

  applyTaskChange(command: ApplyTaskChangeCommand): TaskStateApplyResult {
    return this.deps.lifecyclePort.applyTaskChange(command);
  }

  attachResource(taskId: string, resourcePath: string): Task {
    return this.deps.taskEngine.attachResource(taskId, resourcePath);
  }

  /** The Task that currently owns an execution slot. */
  getCurrentRunningTask(): Task | null {
    return this.listTasksByStatus('running')[0] ?? null;
  }

  /**
   * Candidate Tasks for `/task clear`. Cancellation itself is a Kernel decision
   * applied by the runtime; this only selects the scope.
   */
  clearCandidates(scope: TaskClearScope): Task[] {
    return this.listTasks().filter(task => CLEAR_SCOPE_STATUSES[scope].includes(task.status));
  }

  isClearScopeRunning(scope: TaskClearScope): boolean {
    return this.clearCandidates(scope).some(task => task.status === 'running');
  }
}
