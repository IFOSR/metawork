/**
 * 账户级纯 Repository 簇（ADR-0031 第 2、3、9 节）。
 *
 * 这些服务只依赖账户数据库、无 callback 到会话/执行运行时，是账户作用域的
 * runtime-wide 服务，按账户构造一次。Conversation/Session 不得各自构造。
 */

import type Database from 'better-sqlite3';
import { ExecutionProgressService } from '../execution/execution-progress-service.js';
import { WorkGraphRuntimeService } from '../execution/work-graph-runtime-service.js';
import { SubtaskRepo } from '../storage/subtask-repo.js';
import { TaskEventRepo } from '../storage/task-event-repo.js';
import { WorkGraphRevisionRepo } from '../storage/work-graph-revision-repo.js';
import { KernelEffectOutboxRepo } from '../storage/kernel-effect-outbox-repo.js';
import { TaskExecutionEvidenceRepo } from '../execution/execution-evidence-port.js';
import { KernelExecutorStatusRepo } from '../storage/kernel-executor-status-repo.js';
import { ExecutorAttemptReceiptRepo } from '../storage/executor-attempt-receipt-repo.js';
import { ConversationTaskSchedulerRepo } from '../storage/conversation-task-scheduler-repo.js';

export interface AccountRepositories {
  readonly executionProgressService: ExecutionProgressService;
  readonly subtaskRepo: SubtaskRepo;
  readonly taskEventRepo: TaskEventRepo;
  readonly workGraphRevisionRepo: WorkGraphRevisionRepo;
  readonly effectOutboxRepo: KernelEffectOutboxRepo;
  readonly taskExecutionEvidenceRepo: TaskExecutionEvidenceRepo;
  readonly attemptReceiptRepo: ExecutorAttemptReceiptRepo;
  readonly workGraphRuntimeService: WorkGraphRuntimeService;
  readonly kernelExecutorStatusRepo: KernelExecutorStatusRepo;
  readonly conversationTaskSchedulerRepo: ConversationTaskSchedulerRepo;
}

export function buildAccountRepositories(db: Database.Database): AccountRepositories {
  const subtaskRepo = new SubtaskRepo(db);
  const taskEventRepo = new TaskEventRepo(db);
  const workGraphRevisionRepo = new WorkGraphRevisionRepo(db);
  const effectOutboxRepo = new KernelEffectOutboxRepo(db);
  const taskExecutionEvidenceRepo = new TaskExecutionEvidenceRepo(db);
  const attemptReceiptRepo = new ExecutorAttemptReceiptRepo(db);
  const workGraphRuntimeService = new WorkGraphRuntimeService(
    subtaskRepo,
    taskEventRepo,
    workGraphRevisionRepo,
    taskExecutionEvidenceRepo,
  );

  return {
    executionProgressService: new ExecutionProgressService(db),
    subtaskRepo,
    taskEventRepo,
    workGraphRevisionRepo,
    effectOutboxRepo,
    taskExecutionEvidenceRepo,
    attemptReceiptRepo,
    workGraphRuntimeService,
    kernelExecutorStatusRepo: new KernelExecutorStatusRepo(db),
    conversationTaskSchedulerRepo: new ConversationTaskSchedulerRepo(db),
  };
}
