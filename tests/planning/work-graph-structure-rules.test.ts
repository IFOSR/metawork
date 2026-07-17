import { describe, expect, it } from 'vitest';
import { validateWorkGraphStructure } from '../../src/planning/work-graph-structure-rules.js';

function node(
  id: string,
  dependsOn: string[] = [],
  preferredAgentClassList: ('codex-cli' | 'pi-agent')[] = ['codex-cli'],
) {
  return {
    id,
    title: id,
    goal: id,
    dependsOn,
    requiredCapabilities: ['workspace-engineering'] as const,
    preferredAgentClassList,
    expectedOutput: 'summary' as const,
    acceptance: [id],
    riskLevel: 'low' as const,
  };
}

describe('work graph structure rules', () => {
  it('reports adjacent same-preferred work that one AgentClass should complete as one subtask', () => {
    const violations = validateWorkGraphStructure({
      reason: 'step-shaped work',
      subtasks: [
        {
          id: 'implement',
          title: 'Implement',
          goal: 'Implement the requested change',
          dependsOn: [],
          requiredCapabilities: ['workspace-engineering'],
          preferredAgentClassList: ['codex-cli'],
          expectedOutput: 'patch',
          acceptance: ['Implementation exists'],
          riskLevel: 'medium',
        },
        {
          id: 'verify',
          title: 'Verify',
          goal: 'Run verification',
          dependsOn: ['implement'],
          requiredCapabilities: ['workspace-engineering'],
          preferredAgentClassList: ['codex-cli'],
          expectedOutput: 'summary',
          acceptance: ['Verification is reported'],
          riskLevel: 'low',
        },
      ],
    });

    expect(violations).toContainEqual({
      code: 'mergeable_same_agent_chain',
      subtaskIds: ['implement', 'verify'],
      message: 'subtasks implement -> verify form a mergeable codex-cli single chain',
    });
  });

  it('rejects duplicate preferred AgentClasses in the same derived execution layer', () => {
    const violations = validateWorkGraphStructure({
      reason: 'parallel-looking duplicate ownership',
      subtasks: [node('root'), node('left', ['root']), node('right', ['root'])],
    });

    expect(violations).toContainEqual({
      code: 'same_layer_preferred_conflict',
      subtaskIds: ['left', 'right'],
      message: 'derived layer 1 assigns preferred AgentClass codex-cli more than once: left, right',
    });
  });

  it.each([
    {
      name: 'plain chain',
      subtasks: [node('a'), node('b', ['a'])],
      expected: true,
    },
    {
      name: 'A accepts an upstream join',
      subtasks: [node('left', [], ['pi-agent']), node('right'), node('a', ['left', 'right']), node('b', ['a'])],
      expected: true,
    },
    {
      name: 'B fans out downstream',
      subtasks: [node('a'), node('b', ['a']), node('left', ['b'], ['pi-agent']), node('right', ['b'], ['pi-agent'])],
      expected: true,
    },
    {
      name: 'A has another child',
      subtasks: [node('a'), node('b', ['a']), node('other', ['a'], ['pi-agent'])],
      expected: false,
    },
    {
      name: 'B has another dependency',
      subtasks: [node('a'), node('other', [], ['pi-agent']), node('b', ['a', 'other'])],
      expected: false,
    },
    {
      name: 'preferred AgentClasses differ',
      subtasks: [node('a'), node('b', ['a'], ['pi-agent'])],
      expected: false,
    },
  ])('applies the exact mergeable-chain rule: $name', ({ subtasks, expected }) => {
    const violations = validateWorkGraphStructure({ reason: 'chain matrix', subtasks });
    expect(violations.some(violation => violation.code === 'mergeable_same_agent_chain')).toBe(expected);
  });

  it('reports empty and duplicate IDs plus duplicate, unknown, and self dependencies', () => {
    const violations = validateWorkGraphStructure({
      reason: 'identity matrix',
      subtasks: [
        node(''),
        node('duplicate'),
        node('duplicate'),
        node('self', ['self', 'unknown', 'unknown']),
      ],
    });

    expect(violations.map(violation => violation.code)).toEqual([
      'duplicate_dependency',
      'duplicate_subtask_id',
      'empty_subtask_id',
      'same_layer_preferred_conflict',
      'self_dependency',
      'unknown_dependency',
    ]);
  });

  it('reports malformed dependency graphs with stable violation codes', () => {
    const violations = validateWorkGraphStructure({
      reason: 'invalid dependencies',
      subtasks: [
        {
          id: 'a', title: 'a', goal: 'a', dependsOn: ['b', 'missing', 'missing'],
          requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
          expectedOutput: 'summary', acceptance: ['a'], riskLevel: 'low',
        },
        {
          id: 'b', title: 'b', goal: 'b', dependsOn: ['a'],
          requiredCapabilities: ['current-web-research'], preferredAgentClassList: ['pi-agent'],
          expectedOutput: 'summary', acceptance: ['b'], riskLevel: 'low',
        },
      ],
    });

    expect(violations.map(violation => violation.code)).toEqual([
      'dependency_cycle',
      'duplicate_dependency',
      'missing_entry_node',
      'unknown_dependency',
    ]);
  });
});
