/**
 * 账户级 Kernel 单写者协调器（ADR-0031 第 3 节）。
 *
 * 一个账户只有一个协调器实例，它是唯一允许 claim/decide/apply 账户 durable
 * Kernel inbox 与决策应用的 Application 层所有者。协调器内部持有一个**持久**
 * DurableKernelWorkflow：`drainSerially` 的实例级锁因此升级为账户级锁，
 * 消除了多个 per-conversation `DurableKernelWorkflow` 竞争同一 `kernel_events`
 * 表导致的跨会话抢占。
 *
 * 每个提交事件的 snapshot/runtime context 按事件 ID 保存，应用时再按 decision
 * 的 eventId 解析。后台 drain 不得使用“最后一次绑定”的 Conversation context，
 * 否则 A/B 两个 Conversation 交错时会把 A 的决策应用到 B。
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
  private readonly contexts = new Map<string, AccountKernelCoordinatorSubmitContext>();
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: AccountKernelCoordinatorDeps) {
    this.deps = deps;
  }

  submit(
    event: KernelEvent,
    context: AccountKernelCoordinatorSubmitContext,
  ): Promise<KernelWorkflowResult> {
    return this.enqueue(async () => {
      this.contexts.set(event.id, context);
      return this.ensureWorkflow().submit(event);
    });
  }

  recover(context: AccountKernelCoordinatorSubmitContext): Promise<KernelRecoveryReport> {
    return this.enqueue(async () => {
      this.recoveryContext = context;
      return this.ensureWorkflow().recover();
    });
  }

  private recoveryContext: AccountKernelCoordinatorSubmitContext | null = null;

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
          const context = this.contexts.get(event.id) ?? this.recoveryContext;
          if (!context) throw new Error(`kernel coordinator has no context for event ${event.id}`);
          return context.buildSnapshot(event);
        },
        store: this.deps.store,
        runtime: {
          apply: async decision => {
            const context = this.contexts.get(decision.eventId) ?? this.recoveryContext;
            if (!context) throw new Error(`kernel coordinator has no context for decision ${decision.id}`);
            const observation = await context.runtime.apply(decision);
            // Follow-up Kernel events are emitted by Runtime after applying the
            // decision. They must inherit the immutable owner/application route
            // of the decision that caused them.
            if (observation) this.contexts.set(observation.id, context);
            return observation;
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
