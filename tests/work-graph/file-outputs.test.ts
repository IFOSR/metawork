import { describe, expect, it } from 'vitest';
import { validateWorkGraph } from '../../src/work-graph/validation.js';
import { singleSubtaskWorkGraph } from '../support/planning-agent-plans.js';

describe('file output graph invariants', () => {
  it('requires a file declaration on an artifact-producing upstream node', () => {
    const graph = singleSubtaskWorkGraph({ goal: 'produce', fileOutputs: [] });
    const consumer = singleSubtaskWorkGraph({ goal: 'consume', executor: 'pi-agent' }).subtasks[0]!;
    consumer.id = 'consumer';
    consumer.dependencies = [{ fromSubtaskId: graph.subtasks[0]!.id,
      requiredItems: [{ key: 'source', type: 'artifact', description: 'source file' }] }];
    graph.subtasks.push(consumer);
    expect(validateWorkGraph(graph)).toContainEqual(expect.objectContaining({ code: 'file_outputs_invalid' }));
    graph.subtasks[0]!.fileOutputs = ['data.csv'];
    expect(validateWorkGraph(graph)).toEqual([]);
  });

  it.each([['report.md', 'report.md'], ['../escape'], []].map(fileOutputs => ({ fileOutputs })))('rejects invalid image output contracts $fileOutputs', ({ fileOutputs }) => {
    const graph = singleSubtaskWorkGraph({ goal: 'draw', fileOutputs });
    graph.subtasks[0]!.requiredCapabilities = ['image-generation'];
    expect(validateWorkGraph(graph)).toContainEqual(expect.objectContaining({ code: 'file_outputs_invalid' }));
  });
});
