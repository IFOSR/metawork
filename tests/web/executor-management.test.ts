import { describe, expect, it } from 'vitest';
import { applyExecutorSnapshot } from '../../web/src/executor-management.js';

describe('executor management snapshot reconciliation', () => {
  it('preserves the same assistant local routing edits when only toggling availability', () => {
    expect(applyExecutorSnapshot(
      { first: 'unsaved model' },
      { first: 'saved model' },
      'first',
      { preserveLocal: true },
    )).toEqual({ first: 'unsaved model' });
  });

  it('updates only the saved assistant while preserving other local edits', () => {
    expect(applyExecutorSnapshot(
      { planner: 'local planner', first: 'local first', second: 'old second' },
      { planner: 'server planner', first: 'server first', second: 'new second', third: 'new third' },
      'second',
    )).toEqual({ planner: 'local planner', first: 'local first', second: 'new second' });
  });

  it('adds and removes the exact stable ID without resurrecting deleted assistants', () => {
    expect(applyExecutorSnapshot({ first: 1 }, { first: 1, second: 2 }, 'second'))
      .toEqual({ first: 1, second: 2 });
    expect(applyExecutorSnapshot({ first: 1, second: 2 }, { first: 1 }, 'second'))
      .toEqual({ first: 1 });
  });
});
