export type ConfigurationActivationStatus = 'idle' | 'busy' | 'activating';

export type ConfigurationActivationBlockCode =
  | 'activation_in_progress'
  | 'planner_turn_active'
  | 'work_request_pending'
  | 'unfinished_task'
  | 'task_running'
  | 'executor_attempt_active'
  | 'resource_lease_active'
  | 'publication_pending'
  | 'recovery_in_progress'
  | 'restart_required';

export interface ConfigurationActivationBlock {
  code: ConfigurationActivationBlockCode;
  message: string;
  taskId?: string;
  count?: number;
}

/**
 * 严格空闲事实：仍可继续的未结束任务摘要（ADR-0033 2026-09-19 修正案）。
 * `count` 是全部记录数，`items` 有固定条数上限，仅用于安全诊断展示。
 */
export interface UnfinishedWorkItem {
  taskId: string;
  status: string;
  conversationId: string | null;
}

export interface UnfinishedWorkSummary {
  count: number;
  items: UnfinishedWorkItem[];
}

export interface ConfigurationActivationRuntimeFacts {
  activeTaskId: string | null;
  activeTaskIds?: readonly string[];
  activeConversationCount?: number;
  plannerTurnActive: boolean;
  activeAttemptCount: number;
  activeLeaseCount: number;
  publicationPending: boolean;
  recoveryInProgress: boolean;
  /** 已接收但尚未处理完的业务请求数（工作 reservation）。 */
  pendingWorkRequestCount?: number;
  /** created/ready/parked/blocked 等仍可继续的未结束任务。 */
  unfinishedWork?: UnfinishedWorkSummary;
}

export interface ConfigurationActivationStatusSnapshot
  extends ConfigurationActivationRuntimeFacts {
  status: ConfigurationActivationStatus;
  activationAllowed: boolean;
  blockingReasons: ConfigurationActivationBlock[];
  hotActivationSupported: boolean;
  checkedAt: string;
}

export class ConfigurationActivationBlockedError extends Error {
  readonly code = 'runtime_busy';

  constructor(readonly status: ConfigurationActivationStatusSnapshot) {
    super(status.blockingReasons.map(reason => reason.message).join('; '));
  }
}

export class ConfigurationActivationGate {
  private activating = false;

  constructor(
    private readonly readFacts: () => ConfigurationActivationRuntimeFacts,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getStatus(): ConfigurationActivationStatusSnapshot {
    const facts = this.readFacts();
    const blockingReasons: ConfigurationActivationBlock[] = [];
    if (this.activating) {
      blockingReasons.push({
        code: 'activation_in_progress',
        message: '另一个配置激活事务正在进行。',
      });
    }
    if (facts.plannerTurnActive) {
      blockingReasons.push({
        code: 'planner_turn_active',
        message: 'Planner 正在处理当前请求。',
      });
    }
    if ((facts.pendingWorkRequestCount ?? 0) > 0) {
      blockingReasons.push({
        code: 'work_request_pending',
        message: `${facts.pendingWorkRequestCount} 个已接收的工作请求仍在排队或处理中。`,
        count: facts.pendingWorkRequestCount,
      });
    }
    if ((facts.unfinishedWork?.count ?? 0) > 0) {
      const first = facts.unfinishedWork?.items[0];
      blockingReasons.push({
        code: 'unfinished_task',
        message: first
          ? `${facts.unfinishedWork!.count} 个任务尚未结束（例如 ${first.taskId} 处于 ${first.status}）。请先完成或取消这些任务。`
          : '存在尚未结束的任务，暂时不能修改配置。',
        count: facts.unfinishedWork!.count,
        ...(first ? { taskId: first.taskId } : {}),
      });
    }
    if (facts.activeTaskId) {
      blockingReasons.push({
        code: 'task_running',
        message: facts.activeTaskIds && facts.activeTaskIds.length > 1
          ? `${facts.activeTaskIds.length} 个任务正在后台执行。`
          : `任务 ${facts.activeTaskId} 正在后台执行。`,
        taskId: facts.activeTaskId,
        ...(facts.activeTaskIds && facts.activeTaskIds.length > 1
          ? { count: facts.activeTaskIds.length }
          : {}),
      });
    }
    if (facts.activeAttemptCount > 0) {
      blockingReasons.push({
        code: 'executor_attempt_active',
        message: `${facts.activeAttemptCount} 个 Executor attempt 尚未结束。`,
        count: facts.activeAttemptCount,
      });
    }
    if (facts.activeLeaseCount > 0) {
      blockingReasons.push({
        code: 'resource_lease_active',
        message: `${facts.activeLeaseCount} 个资源 lease 尚未释放。`,
        count: facts.activeLeaseCount,
      });
    }
    if (facts.publicationPending) {
      blockingReasons.push({
        code: 'publication_pending',
        message: 'Git publication 或合并修复尚未完成。',
      });
    }
    if (facts.recoveryInProgress) {
      blockingReasons.push({
        code: 'recovery_in_progress',
        message: '运行时恢复尚未完成。',
      });
    }
    return {
      ...facts,
      status: this.activating ? 'activating' : blockingReasons.length > 0 ? 'busy' : 'idle',
      activationAllowed: blockingReasons.length === 0,
      blockingReasons,
      hotActivationSupported: true,
      checkedAt: this.now(),
    };
  }

  /** 配置事务是否正在进行；新工作接收入口据此对称拒绝。 */
  isActivationInProgress(): boolean {
    return this.activating;
  }

  async withActivation<T>(
    operation: () => Promise<T>,
    options: { allowNested?: boolean } = {},
  ): Promise<T> {
    if (this.activating) {
      if (!options.allowNested) {
        throw new ConfigurationActivationBlockedError(this.getStatus());
      }
      return operation();
    }
    const status = this.getStatus();
    if (!status.activationAllowed) {
      throw new ConfigurationActivationBlockedError(status);
    }
    this.activating = true;
    try {
      const rechecked = this.getStatus();
      if (rechecked.blockingReasons.some(reason => reason.code !== 'activation_in_progress')) {
        throw new ConfigurationActivationBlockedError(rechecked);
      }
      return await operation();
    } finally {
      this.activating = false;
    }
  }
}
