/**
 * Convergence for stale capacity blocks.
 *
 * A partition/capacity yield parks the Task at `queued` with a waiting
 * `kernel_capacity` dependency. That dependency is a *scheduler* fact: once the
 * conflicting resource waits are gone, nothing should keep the Task queued.
 * Before this rule the yield had no wake at all, so a Task could sit in the
 * queue indefinitely while its Conversation slot was still held by itself
 * (`running -> queued`), and promotion required a free slot.
 *
 * Pure: the caller supplies the queued Tasks, the unresolved-wait predicate and
 * the fact writer.
 */

export interface CapacityBlockedTaskFact {
  readonly id: string;
  readonly dependencies: readonly {
    readonly type: string;
    readonly status: string;
    readonly description: string;
    readonly createdAt: string;
    readonly taskId: string;
  }[];
}

export function clearStaleCapacityBlocks(input: {
  tasks: readonly CapacityBlockedTaskFact[];
  /** True while a resource wait of this Task is still unresolved. */
  hasUnresolvedWait(taskId: string): boolean;
  /** Remove the stale scheduler blocker from the Task facts. */
  clear(taskId: string): void;
}): string[] {
  const cleared: string[] = [];
  for (const task of input.tasks) {
    const blocked = task.dependencies.some(dependency => (
      dependency.type === 'kernel_capacity' && dependency.status === 'waiting'
    ));
    if (!blocked) continue;
    if (input.hasUnresolvedWait(task.id)) continue;
    input.clear(task.id);
    cleared.push(task.id);
  }
  return cleared;
}
