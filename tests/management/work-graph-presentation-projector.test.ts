import { describe, expect, it } from 'vitest';
import {
  WorkGraphPresentationProjector,
  type WorkGraphPresentationInput,
} from '../../src/management/work-graph-presentation-projector.js';
import type { ConfigurationSnapshot } from '../../src/configuration/types.js';

function input(): WorkGraphPresentationInput {
  return {
    taskId: 'task-1',
    graphRevision: 1,
    configuration: configuration(),
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
      { id: 'task-1_r1_inspect', status: 'done', generationId: 'generation-1', firstDispatchOrder: 0, hasPendingOrActiveAttempt: false },
      { id: 'task-1_r1_implement', status: 'running', generationId: 'generation-1', firstDispatchOrder: 1, hasPendingOrActiveAttempt: true },
      { id: 'task-1_r1_docs', status: 'ready', generationId: 'generation-1', firstDispatchOrder: 2, hasPendingOrActiveAttempt: false },
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
    dispatchItems: [{ subtaskId: 'task-1_r1_implement', status: 'running', authorizedBinding: {
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

    expect(result.nodes.map(node => node.id)).toEqual([
      'task-1_r1_inspect',
      'task-1_r1_implement',
      'task-1_r1_docs',
    ]);
    expect(result.edges).toEqual(expect.arrayContaining([
      {
        from: 'task-1_r1_inspect',
        to: 'task-1_r1_implement',
        kind: 'handoff',
        label: 'Inspection findings',
      },
    ]));
    expect(result.parallelGroups).toEqual([
      ['task-1_r1_inspect', 'task-1_r1_docs'],
      ['task-1_r1_implement'],
    ]);
    expect(result.currentRunnableFrontier).toEqual(['task-1_r1_docs']);
    expect(result.nodes.find(node => node.id === 'task-1_r1_implement')).toMatchObject({
      status: 'running',
      routing: [{
        executorDisplayName: 'Codex',
        harnessDisplayName: 'Codex CLI',
        policy: 'auto',
        selected: {
          providerDisplayName: 'OpenAI',
          modelDisplayName: 'gpt-coding',
        },
        rejectedCandidates: [{
          providerDisplayName: 'OpenAI',
          modelDisplayName: 'gpt-slow',
          reasonCode: 'latency_limit_exceeded',
        }],
      }],
    });
    expect(JSON.stringify(result)).not.toContain('coding-model');
    expect(JSON.stringify(result)).not.toContain('slow-model');
    expect(JSON.stringify(result)).not.toContain('configurationRevision');
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

function configuration(): ConfigurationSnapshot {
  return {
    revisionId: 'revision-1',
    contentHash: 'sha256:revision-1',
    config: {
      schemaVersion: 2,
      providers: {
        openai: {
          protocol: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          apiKeyRef: 'file-secret:anyfusion/openai',
          region: 'international',
          enabled: true,
        },
      },
      models: {
        'coding-model': {
          providerRef: 'openai',
          modelId: 'gpt-coding',
          capabilities: ['coding'],
          reasoning: 'high',
          enabled: true,
        },
        'slow-model': {
          providerRef: 'openai',
          modelId: 'gpt-slow',
          capabilities: ['coding'],
          reasoning: 'high',
          enabled: true,
        },
      },
      harnesses: {
        'codex-harness': {
          kind: 'executor',
          transport: 'local-cli',
          command: 'codex',
          args: [],
          driverId: 'codex-cli',
          supportsProbe: true,
          supportsAbort: true,
          supportsContinuation: true,
          enabled: true,
        },
      },
      agentClasses: {},
      permissionProfiles: {},
      runtimePolicy: {},
      gateway: {},
    },
  };
}
