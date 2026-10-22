import { describe, expect, it } from 'vitest';
import { subtaskTitle, workGraphTitleIndex } from '../../web/src/work-graph-titles.js';

describe('Work Graph subtask titles', () => {
  it('uses the node title before stale timeline or trace text', () => {
    const titles = workGraphTitleIndex({
      generationId: 'generation',
      nodes: [{
        id: 'subtask-a', title: 'Work Graph 标题', goal: '', status: 'running',
        executionState: 'running', phase: 0, runnable: true, dependencies: [],
        requiredCapabilities: [], acceptanceCriteria: [], routing: [],
      }],
      edges: [], parallelGroups: [], currentRunnableFrontier: ['subtask-a'],
    });

    expect(subtaskTitle(titles, 'subtask-a', '旧时间线标题')).toBe('Work Graph 标题');
    expect(subtaskTitle(titles, 'subtask-b', '旧时间线标题')).toBe('旧时间线标题');
  });
});
