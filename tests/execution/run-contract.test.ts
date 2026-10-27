import { describe, expect, it } from 'vitest';
import { projectRunContract, runContractDiagnostics } from '../../src/execution/run-contract.js';
import type { SubtaskExecutionContext } from '../../src/execution/subtask-execution-context.js';
import type { WorkGraphAcceptanceCriterion } from '../../src/work-graph/index.js';

const acceptance: WorkGraphAcceptanceCriterion[] = [
  { id: 'accept_1', statement: '服务健康检查返回 200', kind: 'command' } as WorkGraphAcceptanceCriterion,
];

function context(overrides: Partial<SubtaskExecutionContext> = {}): SubtaskExecutionContext {
  return {
    taskBackground: { id: 'task_1', title: 'Service', goal: 'Run a service', instruction: 'background_only' },
    currentSubtask: {
      id: 'subtask_1',
      title: 'Write the service',
      goal: 'Write and run the backend service',
      deliveryKind: 'edit',
      fileOutputs: ['server.mjs'],
      requiredCapabilities: ['filesystem_write'],
      acceptance,
    },
    incomingHandoffs: [],
    outgoingHandoffRequirements: [],
    selectedEvidence: [],
    outOfScopeSiblings: [],
    workspaceContext: {
      allowFilesystem: true,
      workingDirectory: '/ws/project',
      targetPaths: ['server.mjs'],
      workspaceId: 'ws_1',
      executionMode: 'in_place',
      accessMode: 'write',
      canonicalRoot: '/ws/project',
    },
    identity: {
      executionId: 'exec_1',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      workUnitId: 'wu_1',
    },
    completionContract: { marker: '---METACLAW-COMPLETE---' as never, schemaVersion: 4 },
    evidenceTools: { availability: 'unavailable', reason: 'not configured' },
    ...overrides,
  } as SubtaskExecutionContext;
}

describe('Run Contract projection', () => {
  it('projects only authorized execution facts', () => {
    const contract = projectRunContract({
      context: context(),
      executionBinding: {
        taskId: 'task_1',
        generationId: 'generation_1',
        subtaskId: 'subtask_1',
        workUnitId: 'wu_1',
        configurationRevision: 'config_7',
        bindingFingerprint: 'binding_hash',
      },
      serviceIntent: { requested: true, serviceId: 'backend', specificationRevision: 'sha256:abc' },
    });
    expect(contract).toEqual({
      taskId: 'task_1',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      workUnitId: 'wu_1',
      workspaceId: 'ws_1',
      workingDirectory: '/ws/project',
      targetPaths: ['server.mjs'],
      accessMode: 'write',
      objective: 'Write and run the backend service',
      acceptance,
      fileOutputs: ['server.mjs'],
      serviceIntent: { requested: true, serviceId: 'backend', specificationRevision: 'sha256:abc' },
      configurationRevision: 'config_7',
      bindingFingerprint: 'binding_hash',
    });
  });

  it('defaults the access mode without inventing an execution binding', () => {
    const contract = projectRunContract({
      context: context({
        workspaceContext: {
          allowFilesystem: true,
          workingDirectory: '/ws/project',
          targetPaths: [],
        },
      }),
    });
    expect(contract.accessMode).toBe('write');
    expect(contract.generationId).toBeNull();
    expect(contract.workUnitId).toBe('wu_1');
    expect(contract.configurationRevision).toBeNull();
    expect(contract.serviceIntent).toBeUndefined();
  });

  it('keeps diagnostics bounded and free of prompt text', () => {
    const contract = projectRunContract({
      context: context(),
      executionBinding: {
        taskId: 'task_1',
        generationId: 'generation_1',
        subtaskId: 'subtask_1',
        workUnitId: 'wu_1',
        configurationRevision: 'config_7',
        bindingFingerprint: 'binding_hash',
      },
    });
    const diagnostics = runContractDiagnostics(contract);
    expect(diagnostics).toMatchObject({
      taskId: 'task_1',
      attemptId: 'attempt_1',
      workspaceId: 'ws_1',
      accessMode: 'write',
      targetPathCount: 1,
      acceptanceCount: 1,
      fileOutputs: ['server.mjs'],
      bindingFingerprint: 'binding_hash',
    });
    expect(JSON.stringify(diagnostics)).not.toContain('Write and run the backend service');
  });
});
