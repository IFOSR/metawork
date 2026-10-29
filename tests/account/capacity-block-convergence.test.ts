import { describe, expect, it } from 'vitest';
import { clearStaleCapacityBlocks, type CapacityBlockedTaskFact } from '../../src/account/capacity-block-convergence.js';

function task(id: string, type: 'kernel_capacity' | 'manual' = 'kernel_capacity'): CapacityBlockedTaskFact {
  return {
    id,
    dependencies: [{
      taskId: id,
      type,
      description: 'resource partition is waiting for leases',
      status: 'waiting',
      createdAt: '2026-10-28T13:55:15.887Z',
    }],
  };
}

describe('stale capacity block convergence', () => {
  it('clears a partition yield once its resource waits are resolved', () => {
    const cleared: string[] = [];
    const result = clearStaleCapacityBlocks({
      tasks: [task('task_a')],
      hasUnresolvedWait: () => false,
      clear: id => cleared.push(id),
    });
    expect(result).toEqual(['task_a']);
    expect(cleared).toEqual(['task_a']);
  });

  it('keeps the block while a resource wait is still unresolved', () => {
    const cleared: string[] = [];
    const result = clearStaleCapacityBlocks({
      tasks: [task('task_a')],
      hasUnresolvedWait: () => true,
      clear: id => cleared.push(id),
    });
    expect(result).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it('never touches a user or system blocker that is not a capacity yield', () => {
    const cleared: string[] = [];
    const result = clearStaleCapacityBlocks({
      tasks: [task('task_manual', 'manual')],
      hasUnresolvedWait: () => false,
      clear: id => cleared.push(id),
    });
    expect(result).toEqual([]);
    expect(cleared).toEqual([]);
  });
});
