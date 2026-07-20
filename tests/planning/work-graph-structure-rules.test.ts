import { describe, expect, it } from 'vitest';
import { validateWorkGraph, type WorkGraphSubtask } from '../../src/work-graph/index.js';

function subtask(
  id: string,
  dependencies: WorkGraphSubtask['dependencies'] = [],
  preferredAgentClassList: WorkGraphSubtask['preferredAgentClassList'] = ['codex-cli'],
): WorkGraphSubtask {
  return {
    id,
    title: id,
    goal: `complete ${id}`,
    dependencies,
    contextRefs: [{ kind: 'current_user_input' }],
    requiredCapabilities: ['workspace-engineering'],
    preferredAgentClassList,
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
    expect(validateWorkGraph({
      subtasks: [subtask('a'), subtask('b', [edge('a')], ['pi-agent'])],
    })).toEqual([]);
  });

  it('reports adjacent same-preferred work that one AgentClass should complete as one Subtask', () => {
    expect(validateWorkGraph({
      subtasks: [subtask('implement'), subtask('verify', [edge('implement')])],
    })).toContainEqual(expect.objectContaining({
      code: 'mergeable_same_agent_chain',
      subtaskIds: ['implement', 'verify'],
      message: 'subtasks implement -> verify form a mergeable codex-cli single chain',
    }));
  });

  it('rejects duplicate preferred AgentClasses in the same derived execution layer', () => {
    expect(validateWorkGraph({
      subtasks: [subtask('root'), subtask('left', [edge('root')]), subtask('right', [edge('root')])],
    })).toContainEqual(expect.objectContaining({
      code: 'same_layer_preferred_conflict',
      subtaskIds: ['left', 'right'],
      message: 'derived layer 1 assigns preferred AgentClass codex-cli more than once: left, right',
    }));
  });

  it.each([
    {
      name: 'plain chain',
      subtasks: [subtask('a'), subtask('b', [edge('a')])],
      expected: true,
    },
    {
      name: 'upstream accepts a join',
      subtasks: [
        subtask('left', [], ['pi-agent']),
        subtask('right'),
        subtask('a', [edge('left'), edge('right')]),
        subtask('b', [edge('a')]),
      ],
      expected: true,
    },
    {
      name: 'downstream fans out later',
      subtasks: [
        subtask('a'),
        subtask('b', [edge('a')]),
        subtask('left', [edge('b')], ['pi-agent']),
        subtask('right', [edge('b')], ['pi-agent']),
      ],
      expected: true,
    },
    {
      name: 'upstream has another child',
      subtasks: [
        subtask('a'),
        subtask('b', [edge('a')]),
        subtask('other', [edge('a')], ['pi-agent']),
      ],
      expected: false,
    },
    {
      name: 'downstream has another dependency',
      subtasks: [
        subtask('a'),
        subtask('other', [], ['pi-agent']),
        subtask('b', [edge('a'), edge('other')]),
      ],
      expected: false,
    },
    {
      name: 'preferred AgentClasses differ',
      subtasks: [subtask('a'), subtask('b', [edge('a')], ['pi-agent'])],
      expected: false,
    },
  ])('applies the exact mergeable-chain rule: $name', ({ subtasks, expected }) => {
    const violations = validateWorkGraph({ subtasks });
    expect(violations.some(item => item.code === 'mergeable_same_agent_chain')).toBe(expected);
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
