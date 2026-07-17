import { describe, expect, it } from 'vitest';
import { validateWorkGraph, type WorkGraphSubtask } from '../../src/work-graph/index.js';

function subtask(id: string, dependencies: WorkGraphSubtask['dependencies'] = []): WorkGraphSubtask {
  return {
    id,
    title: id,
    goal: `complete ${id}`,
    dependencies,
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList: ['codex-cli'],
    expectedOutput: 'summary',
    acceptance: [{ key: 'complete', description: `complete ${id}`, requiredEvidence: [] }],
    riskLevel: 'low',
  };
}

function edge(fromSubtaskId: string): WorkGraphSubtask['dependencies'][number] {
  return {
    fromSubtaskId,
    requiredItems: [{ key: 'result', type: 'text', description: 'normalized upstream result' }],
  };
}

describe('Work Graph v4 structural rules', () => {
  it('accepts a valid direct handoff graph', () => {
    expect(validateWorkGraph({ subtasks: [subtask('a'), subtask('b', [edge('a')])] })).toEqual([]);
  });

  it('rejects ordering-only dependencies', () => {
    const graph = { subtasks: [subtask('a'), subtask('b', [{ fromSubtaskId: 'a', requiredItems: [] }])] };
    expect(validateWorkGraph(graph).map(item => item.code)).toContain('dependency_items_count_invalid');
  });

  it('rejects duplicate keys, invalid keys and duplicate context refs', () => {
    const invalid = subtask('a');
    invalid.acceptance = [
      { key: 'Bad Key', description: 'one', requiredEvidence: [] },
      { key: 'Bad Key', description: 'two', requiredEvidence: [] },
    ];
    invalid.contextRefs = [{ kind: 'current_user_input' }, { kind: 'current_user_input' }];
    expect(validateWorkGraph({ subtasks: [invalid] }).map(item => item.code)).toEqual(expect.arrayContaining([
      'duplicate_acceptance_key',
      'duplicate_context_ref',
      'invalid_key',
    ]));
  });

  it('rejects unknown dependencies and cycles', () => {
    expect(validateWorkGraph({ subtasks: [subtask('a', [edge('missing')])] }).map(item => item.code))
      .toEqual(expect.arrayContaining(['missing_entry_node', 'unknown_dependency']));
    expect(validateWorkGraph({ subtasks: [subtask('a', [edge('b')]), subtask('b', [edge('a')])] }).map(item => item.code))
      .toEqual(expect.arrayContaining(['dependency_cycle', 'missing_entry_node']));
  });
});
