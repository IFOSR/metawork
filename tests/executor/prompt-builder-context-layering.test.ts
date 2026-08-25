import { describe, expect, it } from 'vitest';
import { buildExecutorContextPrompt } from '../../src/executor/prompt-builder.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';

function input(): ExecutorInput {
  return {
    context: {
      taskBackground: { id: 'internal-task-id', title: 'Task', goal: 'Top-level goal', instruction: 'background_only' as const },
      currentSubtask: {
        id: 'internal-subtask-id',
        title: 'A',
        goal: 'Only do A',
        deliveryKind: 'report' as const,
        acceptance: [
          { key: 'secret_acceptance_key_one', description: 'file exists', requiredEvidence: [] },
          { key: 'secret_acceptance_key_two', description: 'output verified', requiredEvidence: [] },
        ],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [{ toSubtaskId: 'internal-downstream-id', requiredItems: [{ key: 'secret_handoff_key', type: 'text' as const, description: 'summary' }] }],
      selectedEvidence: [{ ref: { kind: 'current_user_input' as const }, evidenceId: 'internal-evidence-id', title: 'Current input', content: 'selected evidence only', truncated: false }],
      outOfScopeSiblings: [{ id: 'internal-sibling-id', title: 'B' }],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'internal-execution-id', taskId: 'internal-task-id', subtaskId: 'internal-subtask-id', attemptId: 'internal-attempt-id', workUnitId: 'internal-work-unit-id' },
      completionContract: { marker: COMPLETION_MARKER_V4, schemaVersion: 4 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'unit test' },
    },
  };
}

describe('Subtask execution prompt layering', () => {
  it('marks the Task goal background-only and the Subtask goal operative', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('Background goal: Top-level goal');
    expect(prompt).toContain('Operative goal: Only do A');
    expect(prompt).toContain('background only');
  });

  it('renders only selected evidence, direct handoffs, sibling titles and completion contract', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('selected evidence only');
    expect(prompt).toContain('"title": "B"');
    expect(prompt).toContain(COMPLETION_MARKER_V4);
    expect(prompt).not.toContain('internal-downstream-id');
    expect(prompt).not.toContain('internal-evidence-id');
    expect(prompt).not.toContain('internal-sibling-id');
    expect(prompt).not.toContain('conversationHistory');
    expect(prompt).not.toContain('executionContextBundle');
  });

  it('renders ResultReference metadata without copying the upstream body', () => {
    const referenceInput = input();
    referenceInput.context.incomingHandoffs = [{
      taskId: 'internal-task-id',
      fromSubtaskId: 'source-subtask',
      toSubtaskId: 'internal-subtask-id',
      attemptId: 'source-attempt',
      items: [{
        key: 'summary',
        type: 'result_reference',
        referenceId: 'reference-source-target',
        summary: 'Authorized upstream result for summary',
      }],
      resultReference: {
        referenceId: 'reference-source-target',
        resultId: 'result-source',
        accountId: 'local-default',
        taskId: 'internal-task-id',
        generationId: 'generation-1',
        sourceSubtaskId: 'source-subtask',
        targetSubtaskId: 'internal-subtask-id',
        edgeKey: 'source->target',
        requiredItems: ['summary'],
        readScope: {
          kind: 'direct_dependency',
          offset: 0,
          length: 100,
          summaryHash: 'sha256:summary',
        },
        contentHash: 'sha256:body',
        byteLength: 100,
        mediaType: 'text/markdown',
        completeness: 'complete',
        createdAt: '2026-08-21T00:00:00.000Z',
      },
      completionSchemaVersion: 4,
      createdAt: '2026-08-21T00:00:00.000Z',
    }];

    const prompt = buildExecutorContextPrompt(referenceInput);

    expect(prompt).toContain('reference-source-target');
    expect(prompt).toContain('result_reference_get');
    expect(prompt).toContain('Authorized upstream result for summary');
    expect(prompt).not.toContain('full upstream body');
  });

  it('renders an identity-free completion report while Runtime owns all authoritative identities and keys', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('{"evidence":["<evidence that the work and checks succeeded>"],"noChangeReason":null}');
    expect(prompt).toContain('Runtime derives changed files and injects schema identity, attempt/work-unit/subtask IDs, acceptance keys, and handoff identities');
    for (const internalValue of [
      'internal-task-id',
      'internal-subtask-id',
      'internal-execution-id',
      'internal-attempt-id',
      'internal-work-unit-id',
      'secret_acceptance_key_one',
      'secret_acceptance_key_two',
      'secret_handoff_key',
    ]) {
      expect(prompt).not.toContain(internalValue);
    }
    expect(prompt).not.toContain('acceptanceEvidence');
    expect(prompt).not.toContain('schemaVersion');
  });

  it('renders only the dedicated merge-repair completion protocol', () => {
    const mergeRepairInput = input();
    mergeRepairInput.context.currentSubtask.deliveryKind = 'edit';
    mergeRepairInput.context.completionContract = {
      marker: '---METACLAW-MERGE-REPAIR---',
      protocol: 'metaclaw:merge-repair:v1',
      allowedPaths: ['src/shared.ts'],
    };

    const prompt = buildExecutorContextPrompt(mergeRepairInput);

    expect(prompt).toContain(
      '{"protocol":"metaclaw:merge-repair:v1","resolvedPaths":["src/shared.ts"],"verification":{"summary":"<verification summary>"}}',
    );
    expect(prompt).not.toContain('"evidence"');
    expect(prompt).not.toContain('"noChangeReason"');
    expect(prompt).not.toContain('completion metadata');
  });

  it('keeps recovery attempt identity out of the model-facing recovery packet', () => {
    const recoveryInput = input();
    recoveryInput.context.recovery = {
      mode: 'recovery_packet',
      sourceAttemptId: 'internal-source-attempt-id',
      packet: {
        sourceAttemptId: 'internal-source-attempt-id',
        failure: { code: 'task_failed', summary: 'previous approach failed' },
        knownProgress: { fileCreated: true },
        workspaceDelta: {},
        confirmedCompleted: ['created file'],
        unknownItems: ['run tests'],
      },
    };

    const prompt = buildExecutorContextPrompt(recoveryInput);
    expect(prompt).toContain('previous approach failed');
    expect(prompt).toContain('created file');
    expect(prompt).not.toContain('internal-source-attempt-id');
    expect(prompt).not.toContain('sourceAttemptId');
  });
});
