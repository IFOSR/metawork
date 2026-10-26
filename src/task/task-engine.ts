// Owns Task creation primitives and non-lifecycle metadata bookkeeping.
//
// The Task status machine is not here: `TaskLifecyclePort.applyTaskChange()` in
// `task-lifecycle-transition-port.ts` is the only writer of `tasks.status`.
import type { Task, TaskSnapshot } from '../core/types.js';
import type { TaskRepo } from '../storage/task-repo.js';
import type { TaskStateChangeRepo } from '../storage/task-state-change-repo.js';
import { generateTaskId } from '../utils/id.js';
import { createTaskReason, type TaskStateDetail } from './task-state.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

export interface TaskEngineDeps {
  taskRepo: TaskRepo;
  snapshotDir: string;
  /** Durable state change ledger; the creation baseline is version 1. */
  stateChanges?: TaskStateChangeRepo;
}

/** Encapsulates Task creation, snapshot persistence and non-lifecycle metadata. */
export class TaskEngine {
  private readonly taskRepo: TaskRepo;
  private readonly snapshotDir: string;
  private readonly stateChanges?: TaskStateChangeRepo;

  constructor(deps: TaskEngineDeps);
  constructor(taskRepo: TaskRepo, snapshotDir: string, stateChanges?: TaskStateChangeRepo);
  constructor(
    deps: TaskEngineDeps | TaskRepo,
    snapshotDir?: string,
    stateChanges?: TaskStateChangeRepo,
  ) {
    if (deps instanceof Object && 'taskRepo' in deps) {
      this.taskRepo = deps.taskRepo;
      this.snapshotDir = deps.snapshotDir;
      this.stateChanges = deps.stateChanges;
    } else {
      this.taskRepo = deps as TaskRepo;
      this.snapshotDir = snapshotDir!;
      this.stateChanges = stateChanges;
    }
  }

  getTaskRepo(): TaskRepo {
    return this.taskRepo;
  }

  list(): Task[] {
    return this.taskRepo.findAll();
  }

  /**
   * Creates a Task already in `queued`. A half-created Task with no authorized
   * work never exists, so creation is not a status transition.
   */
  create(input: {
    id?: string;
    title: string;
    goal: string;
    resources?: string[];
    accountId?: string;
    conversationId?: string;
    workspaceId?: string;
    ownerPlannerSessionId?: string;
    admittedAt?: string;
    publicTaskDirectory?: string;
    publicDeliveryBaseline?: Record<string, string>;
    startServiceAfterPublish?: boolean;
    executionMode?: 'worktree' | 'in_place';
    workspaceExecutionSource?: Task['workspaceExecutionSource'];
    workspaceDeliveryPolicy?: Task['workspaceDeliveryPolicy'];
    workspaceTargetPaths?: string[];
    workspaceIntent?: Task['workspaceIntent'];
    retryOfTaskId?: string | null;
    stateDetail?: TaskStateDetail;
  }): Task {
    const now = new Date().toISOString();
    const taskId = input.id?.trim() ? input.id : generateTaskId();
    const stateDetail = input.stateDetail ?? {
      reason: createTaskReason('waiting_for_capacity', '等待执行名额。'),
      unresolved: [],
      phase: null,
      pendingActions: [],
      requiredWork: [],
      cleanup: { state: 'none', objects: [], reason: '' },
      nextWakeAt: null,
    };
    const task: Task = {
      id: taskId,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.ownerPlannerSessionId ? { ownerPlannerSessionId: input.ownerPlannerSessionId } : {}),
      ...(input.admittedAt ? { admittedAt: input.admittedAt } : {}),
      title: input.title,
      ...(input.publicTaskDirectory ? { publicTaskDirectory: input.publicTaskDirectory } : {}),
      publicDeliveryBaseline: input.publicDeliveryBaseline ?? {},
      publicProject: input.publicTaskDirectory !== undefined,
      startServiceAfterPublish: input.startServiceAfterPublish ?? false,
      executionMode: input.executionMode ?? 'in_place',
      ...(input.workspaceExecutionSource
        ? { workspaceExecutionSource: input.workspaceExecutionSource } : {}),
      ...(input.workspaceDeliveryPolicy
        ? { workspaceDeliveryPolicy: input.workspaceDeliveryPolicy } : {}),
      ...(input.workspaceTargetPaths
        ? { workspaceTargetPaths: [...input.workspaceTargetPaths] } : {}),
      ...(input.workspaceIntent ? { workspaceIntent: input.workspaceIntent } : {}),
      goal: input.goal,
      status: 'queued',
      stateVersion: 1,
      stateDetail,
      completedAt: null,
      archivedAt: null,
      retryOfTaskId: input.retryOfTaskId ?? null,
      summary: '',
      snapshots: [],
      resources: input.resources || [],
      artifacts: [],
      dependencies: [],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0,
        blocksOthers: false,
        idleHours: 0,
      },
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.taskRepo.insert(task);
    this.stateChanges?.insert({
      taskId,
      version: 1,
      operationKey: `create:${taskId}`,
      decisionId: `create:${taskId}`,
      fromStatus: 'queued',
      toStatus: 'queued',
      detail: stateDetail,
      evidenceRefs: [],
      createdAt: now,
    });
    return task;
  }

  /**
   * Associate a resource. Metadata only: it never changes the Task conclusion.
   */
  attachResource(taskId: string, resourcePath: string): Task {
    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error(`任务不存在: ${taskId}`);

    const resources = Array.from(new Set([...task.resources, resourcePath]));
    this.taskRepo.update(taskId, { resources });

    return this.taskRepo.findById(taskId)!;
  }

  getLatestSnapshot(taskId: string): TaskSnapshot | null {
    const task = this.taskRepo.findById(taskId);
    if (!task || task.snapshots.length === 0) return null;
    return task.snapshots[task.snapshots.length - 1];
  }

  saveSnapshot(taskId: string, snapshot: TaskSnapshot): void {
    const taskSnapshotDir = resolve(this.snapshotDir, taskId);
    if (!existsSync(taskSnapshotDir)) {
      mkdirSync(taskSnapshotDir, { recursive: true });
    }

    const filename = `snapshot_${Date.now()}.json`;
    const filepath = resolve(taskSnapshotDir, filename);
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }
}
