/**
 * 账户级 Kernel 单写者协调器（ADR-0031 第 3 节）。
 *
 * 一个账户只有一个协调器实例，它是唯一允许 claim/decide/apply 账户 durable
 * Kernel inbox 与决策应用的 Application 层所有者。协调器内部持有一个**持久**
 * DurableKernelWorkflow：`drainSerially` 的实例级锁因此升级为账户级锁，
 * 消除了多个 per-conversation `DurableKernelWorkflow` 竞争同一 `kernel_events`
 * 表导致的跨会话抢占。
 *
 * 会话级 `buildSnapshot` 与 `runtime` 随每次 `submit`/`recover` 通过 context
 * 提供（它们依赖具体 turn 的输入与上下文），协调器用可变引用在 drain 期间
 * 读取最新值。当前 local-default 单会话下 submit 由 ConversationInputMailbox
 * 串行化，无并发覆盖；多会话并发提交需在未来的多账户 ADR 中引入按事件
 * 存储 context 的更严谨排队。
 */

import type {
  KernelDecider,
  KernelRecoveryReport,
  KernelRuntime,
  KernelWorkflowClock,
  KernelWorkflowResult,
  KernelWorkflowStore,
} from '../kernel/kernel-workflow.js';
import { DurableKernelWorkflow } from '../kernel/kernel-workflow.js';
import type { KernelDecisionAction, KernelEvent, KernelSnapshot } from '../kernel/control-kernel.js';

export interface AccountKernelCoordinatorDeps {
  kernel: KernelDecider;
  store: KernelWorkflowStore;
  clock: KernelWorkflowClock;
  acceptedEventTypes?: KernelEvent['type'][];
  acceptedActions?: KernelDecisionAction['type'][];
  taskId?: string;
}

export interface AccountKernelCoordinatorSubmitContext {
  buildSnapshot(event: KernelEvent): KernelSnapshot;
  runtime: KernelRuntime;
}

export interface AccountKernelCoordinator {
  submit(event: KernelEvent, context: AccountKernelCoordinatorSubmitContext): Promise<KernelWorkflowResult>;
  recover(context: AccountKernelCoordinatorSubmitContext): Promise<KernelRecoveryReport>;
}

export class AccountKernelCoordinator implements AccountKernelCoordinator {
  private readonly deps: AccountKernelCoordinatorDeps;
  private workflow: DurableKernelWorkflow | null = null;
  private buildSnapshotRef: ((event: KernelEvent) => KernelSnapshot) | null = null;
  private runtimeRef: KernelRuntime | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: AccountKernelCoordinatorDeps) {
    this.deps = deps;
  }

  submit(
    event: KernelEvent,
    context: AccountKernelCoordinatorSubmitContext,
  ): Promise<KernelWorkflowResult> {
    return this.enqueue(async () => {
      this.bind(context);
      return this.ensureWorkflow().submit(event);
    });
  }

  recover(context: AccountKernelCoordinatorSubmitContext): Promise<KernelRecoveryReport> {
    return this.enqueue(async () => {
      this.bind(context);
      return this.ensureWorkflow().recover();
    });
  }

  private bind(context: AccountKernelCoordinatorSubmitContext): void {
    this.buildSnapshotRef = context.buildSnapshot;
    this.runtimeRef = context.runtime;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private ensureWorkflow(): DurableKernelWorkflow {
    if (!this.workflow) {
      this.workflow = new DurableKernelWorkflow({
        kernel: this.deps.kernel,
        buildSnapshot: event => {
          if (!this.buildSnapshotRef) throw new Error('kernel coordinator is not bound to a snapshot builder');
          return this.buildSnapshotRef(event);
        },
        store: this.deps.store,
        runtime: {
          apply: decision => {
            if (!this.runtimeRef) throw new Error('kernel coordinator is not bound to a runtime');
            return this.runtimeRef.apply(decision);
          },
        },
        clock: this.deps.clock,
        acceptedEventTypes: this.deps.acceptedEventTypes,
        acceptedActions: this.deps.acceptedActions,
        taskId: this.deps.taskId,
      });
    }
    return this.workflow;
  }
}
