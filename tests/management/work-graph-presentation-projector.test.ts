import { describe, expect, it } from 'vitest';
import {
  WorkGraphPresentationProjector,
  type WorkGraphPresentationInput,
} from '../../src/management/work-graph-presentation-projector.js';

function input(): WorkGraphPresentationInput {
  return {
    graph: {
      schemaVersion: 7,
      configurationRevision: 'revision-1',
      reason: 'parallel implementation',
      subtasks: [
        {
          id: 'inspect',
          title: 'Inspect',
          goal: 'Inspect the repository',
          dependencies: [],
          contextRefs: [],
          requiredCapabilities: ['workspace-engineering'],
          executorBindings: [{ agentClassRef: 'codex', modelSelection: { mode: 'agent-class-default' } }],
          deliveryKind: 'report',
          acceptance: [{ key: 'report', description: 'Report findings', requiredEvidence: [] }],
          riskLevel: 'low',
        },
        {
          id: 'implement',
          title: 'Implement',
          goal: 'Implement the change',
          dependencies: [{
            fromSubtaskId: 'inspect',
            requiredItems: [{ key: 'findings', type: 'text', description: 'Inspection findings' }],
          }],
          contextRefs: [],
          requiredCapabilities: ['workspace-engineering'],
          executorBindings: [{ agentClassRef: 'codex', modelSelection: { mode: 'agent-class-default' } }],
          deliveryKind: 'edit',
          acceptance: [{ key: 'tests', description: 'Tests pass', requiredEvidence: ['test-run'] }],
          riskLevel: 'medium',
        },
        {
          id: 'docs',
          title: 'Document',
          goal: 'Document the change',
          dependencies: [],
          contextRefs: [],
          requiredCapabilities: ['workspace-engineering'],
          executorBindings: [{ agentClassRef: 'codex', modelSelection: { mode: 'agent-class-default' } }],
          deliveryKind: 'report',
          acceptance: [],
          riskLevel: 'low',
        },
      ],
    },
    subtasks: [
      { id: 'inspect', status: 'done', generationId: 'generation-1', firstDispatchOrder: 0, hasPendingOrActiveAttempt: false },
      { id: 'implement', status: 'running', generationId: 'generation-1', firstDispatchOrder: 1, hasPendingOrActiveAttempt: true },
      { id: 'docs', status: 'ready', generationId: 'generation-1', firstDispatchOrder: 2, hasPendingOrActiveAttempt: false },
    ],
    decisions: [{
      taskId: 'task-1',
      subtaskId: 'implement',
      action: 'authorize_task_plan',
      authorizedBindings: [{
        agentClassRef: 'codex',
        harnessRef: 'codex-harness',
        providerRef: 'openai',
        modelRef: 'coding-model',
        permissionProfileRef: 'workspace-engineering',
        configurationRevision: 'revision-1',
      }],
      routing: [{
        agentClassRef: 'codex',
        policy: 'auto',
        rejectedCandidates: [{ modelRef: 'slow-model', providerRef: 'openai', reason: 'latency_limit_exceeded' }],
        estimatedCost: 0.02,
        estimatedLatencyMs: 800,
      }],
    }],
    dispatchItems: [{ subtaskId: 'implement', status: 'running', authorizedBinding: {
      agentClassRef: 'codex',
      harnessRef: 'codex-harness',
      providerRef: 'openai',
      modelRef: 'coding-model',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: 'revision-1',
    } }],
    receipts: [],
    publications: [],
  };
}

describe('WorkGraphPresentationProjector', () => {
  it('projects dependency edges, parallel groups, frontier and concrete routing facts', () => {
    const result = new WorkGraphPresentationProjector().project(input());

    expect(result.configurationRevision).toBe('revision-1');
    expect(result.nodes.map(node => node.id)).toEqual(['inspect', 'implement', 'docs']);
    expect(result.edges).toEqual(expect.arrayContaining([
      { from: 'inspect', to: 'implement', kind: 'handoff', label: 'Inspection findings' },
    ]));
    expect(result.parallelGroups).toEqual([
      ['inspect', 'docs'],
      ['implement'],
    ]);
    expect(result.currentRunnableFrontier).toEqual(['docs']);
    expect(result.nodes.find(node => node.id === 'implement')).toMatchObject({
      status: 'running',
      routing: [{
        providerRef: 'openai',
        modelRef: 'coding-model',
        policy: 'auto',
        rejectedCandidates: [{ reason: 'latency_limit_exceeded' }],
      }],
    });
  });

  it('does not expose prompt, credential or raw process fields', () => {
    const result = new WorkGraphPresentationProjector().project({
      ...input(),
      decisions: [{
        ...input().decisions[0]!,
        routing: [{
          agentClassRef: 'codex',
          policy: 'fixed',
          rejectedCandidates: [],
          rawPrompt: 'secret prompt',
          apiKey: 'secret-key',
        }],
      }],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('secret-key');
    expect(serialized).not.toContain('rawPrompt');
  });
});
