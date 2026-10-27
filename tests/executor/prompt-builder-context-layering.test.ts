import { describe, expect, it } from 'vitest';
import { buildExecutorContextPrompt } from '../../src/executor/prompt-builder.js';
import type { ExecutorInput } from '../../src/executor/adapter.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import { parseChartSpec } from '../../web/src/charts/chart-spec';

function input(): ExecutorInput {
  return {
    context: {
      taskBackground: { id: 'internal-task-id', title: 'Task', goal: 'Top-level goal', instruction: 'background_only' as const },
      currentSubtask: {
        id: 'internal-subtask-id',
        title: 'A',
        goal: 'Only do A',
        deliveryKind: 'report' as const,
        requiredCapabilities: [],
        acceptance: [
          { key: 'secret_acceptance_key_one', description: 'file exists', requiredEvidence: [] },
          { key: 'secret_acceptance_key_two', description: 'output verified', requiredEvidence: [] },
        ],
      },
      incomingHandoffs: [],
      outgoingHandoffRequirements: [{ toSubtaskId: 'internal-downstream-id', requiredItems: [{ key: 'secret_handoff_key', type: 'text' as const, description: 'summary' }] }],
      selectedEvidence: [{ ref: { kind: 'current_user_input' as const }, evidenceId: 'internal-evidence-id', title: 'Current input', content: 'selected evidence only', truncated: false }],
      selectedArtifacts: [{
        ref: { kind: 'artifact', artifactId: 'internal-artifact-id' },
        artifactId: 'internal-artifact-id',
        displayName: 'generated-image.jpg',
        relativeInputPath: '01-generated-image.jpg',
        mediaType: 'image/jpeg',
        contentHash: 'sha256:image',
      }],
      outOfScopeSiblings: [{ id: 'internal-sibling-id', title: 'B' }],
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      identity: { executionId: 'internal-execution-id', taskId: 'internal-task-id', subtaskId: 'internal-subtask-id', attemptId: 'internal-attempt-id', workUnitId: 'internal-work-unit-id' },
      completionContract: { marker: COMPLETION_MARKER_V4, schemaVersion: 4 as const },
      evidenceTools: { availability: 'unavailable' as const, reason: 'unit test' },
    },
  };
}

describe('Subtask execution prompt layering', () => {
  it('teaches a renderable inline chart without requesting files or inventing data', () => {
    const request = input(); request.context.currentSubtask.fileOutputs = [];
    const prompt = buildExecutorContextPrompt(request);
    const example = prompt.match(/```chart\n([^]*?)\n```/u)?.[1];
    expect(parseChartSpec(example!)).toMatchObject({ ok: true });
    expect(prompt).toContain('Never invent values');
    expect(prompt).toContain('null means missing, never zero');
    expect(prompt).toContain('not file deliverables');
    expect(prompt).toContain('No file delivery is requested.');
  });
  it('instructs no-file actions to return inline receipts while preserving explicit document delivery', () => {
    const action = input();
    action.context.currentSubtask.goal = '打开浏览器进入百度。';
    action.context.currentSubtask.fileOutputs = [];
    expect(buildExecutorContextPrompt(action)).toContain('No file delivery is requested.');
    expect(buildExecutorContextPrompt(action)).toContain('Do not create any extra report or evidence files.');
    action.context.currentSubtask.fileOutputs = ['deck.pptx'];
    expect(buildExecutorContextPrompt(action)).toContain('Planner-declared fileOutputs: ["deck.pptx"]');
    expect(buildExecutorContextPrompt(action)).toContain('Produce every declared file output, or verify an existing file');
    expect(buildExecutorContextPrompt(action)).not.toContain('No file delivery is requested.');
  });
  it.each([
    ['/task/files', '/task/inputs'],
    ['C:\\task\\files', 'C:\\task\\inputs'],
  ])('locates selected inputs from the actual workspace %s', (workspacePath, inputsPath) => {
    const selected = input();
    selected.executionBinding = {
      ...selected.context.identity, generationId: 'generation', leaseToken: 'lease',
      idempotencyKey: 'key', workspaceId: 'workspace', workspacePath,
      inputsPath, sourcePath: '/source', handoffsPath: '/handoffs', controlNetwork: 'control',
    };
    selected.context.selectedAttachments = [{
      attachmentId: 'attachment', ref: { kind: 'attachment', attachmentId: 'attachment' },
      displayName: '附件.txt', relativeInputPath: 'input-02-附件.txt',
      mediaType: 'text/plain', contentHash: 'hash',
    }];
    const prompt = buildExecutorContextPrompt(selected);
    expect(prompt).toContain('"readPath": "../inputs/01-generated-image.jpg"');
    expect(prompt).toContain('"readPath": "../inputs/input-02-附件.txt"');
    expect(prompt).toContain('NOT the working directory');
    expect(prompt).toContain('Do not search the whole disk');
  });

  it('mandates web_search as the primary web channel with bash curl only as fallback', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('web_search');
    expect(prompt).toMatch(/web_search[\s\S]{0,240}(网络不可用|fall ?back)/i);
  });

  it('marks the Task goal background-only and the Subtask goal operative', () => {
    const prompt = buildExecutorContextPrompt(input());
    expect(prompt).toContain('Background goal: Top-level goal');
    expect(prompt).toContain('Operative goal: Only do A');
    expect(prompt).toContain('background only');
  });

  it('renders the image artifact protocol for image-capable edit subtasks', () => {
    const imageInput = input();
    imageInput.context.currentSubtask.deliveryKind = 'edit';
    imageInput.context.currentSubtask.requiredCapabilities = ['image-generation'];

    const prompt = buildExecutorContextPrompt(imageInput);

    expect(prompt).toContain('Required routing capabilities: image-generation');
    expect(prompt).toContain('Image artifact protocol: workspace-image-artifact-v1');
    expect(prompt).toContain('write at least one valid PNG, JPEG, WebP, or GIF image file');
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

  it('renders authorized historical artifact inputs without exposing their source identity', () => {
    const prompt = buildExecutorContextPrompt(input());

    expect(prompt).toContain('Planner-selected artifact inputs');
    expect(prompt).toContain('01-generated-image.jpg');
    expect(prompt).toContain('generated-image.jpg');
    expect(prompt).not.toContain('internal-artifact-id');
    expect(prompt).not.toContain('sha256:image');
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
    expect(prompt).toContain('The workspace is the primary task and publication context, not a read-only boundary');
    expect(prompt).toContain('You may read and write ordinary user-space files outside it when useful for the task');
    expect(prompt).not.toContain('the workspace must remain unchanged');
    expect(prompt).not.toContain('Work only within the default authorized workspace boundary');
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

  it('keeps document parsing Executor-owned instead of naming a MetaWork parser', () => {
    const attachmentInput = input();
    attachmentInput.context.selectedAttachments = [{
      ref: { kind: 'attachment', attachmentId: 'internal-attachment-id' },
      attachmentId: 'internal-attachment-id',
      displayName: 'menu.xlsx',
      relativeInputPath: '01-menu.xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentHash: 'sha256:attachment',
    }];

    const prompt = buildExecutorContextPrompt(attachmentInput);
    expect(prompt).toContain('01-menu.xlsx');
    expect(prompt).toContain('Attachment processing:');
    expect(prompt).toContain('MetaWork ships no document parser');
    expect(prompt).not.toContain('METAWORK_DOCUMENT_READER');
    expect(prompt).not.toContain('metawork-document-reader');
  });
});

describe('service repair feedback reaches the Executor', () => {
  it('hands the model the exact service facts it must repair', () => {
    const request = input();
    request.context.recovery = {
      mode: 'recovery_packet',
      sourceAttemptId: 'attempt-source',
      packet: {
        failure: {
          kind: 'service',
          code: 'service_start_failed',
          summary: '服务进程已退出，需显式重启',
          terminalState: 'service_verification_failed',
        },
        service: {
          serviceId: 'backend',
          specificationRevision: 'service_revision_x',
          repairOrdinal: 0,
          command: 'node',
          args: ['server.mjs'],
          healthUrl: 'http://127.0.0.1:8811/health',
          state: 'failed',
          exitObserved: true,
          healthStatus: 503,
          logTail: 'Error: listen EADDRINUSE :::8811',
        },
        knownProgress: ['代码已经写入授权 Workspace'],
        unknownItems: ['当前代码是否已修复服务未就绪的真实原因'],
      },
    };
    const prompt = buildExecutorContextPrompt(request);
    expect(prompt).toContain('Recovery mode: recovery_packet');
    expect(prompt).toContain('"serviceId": "backend"');
    expect(prompt).toContain('Error: listen EADDRINUSE');
    expect(prompt).toContain('"healthStatus": 503');
    expect(prompt).toContain('"repairOrdinal": 0');
    expect(prompt).toContain('当前代码是否已修复服务未就绪的真实原因');
    // The model is told the code is already in place and to verify its own fix.
    expect(prompt).toContain('This round repairs a local service that did not become healthy');
    expect(prompt).toContain('run the service yourself to confirm it answers');
  });
});

describe('previous round context', () => {
  it('tells the Executor which failure not to repeat', () => {
    const request = input();
    request.context.previousRound = {
      taskId: 'task_previous',
      goal: 'run the backend service',
      reasonCode: 'service_start_failed',
      reason: '服务进程已退出，需显式重启',
      operations: [
        { kind: 'service', outcome: 'definite_failure', reasonCode: 'service_start_failed', message: '退出码 1' },
      ],
    };
    const prompt = buildExecutorContextPrompt(request);
    expect(prompt).toContain('Previous failed round in this Workspace:');
    expect(prompt).toContain('Goal: run the backend service');
    expect(prompt).toContain('Conclusion: 服务进程已退出，需显式重启');
    expect(prompt).toContain('Reason code: service_start_failed');
    expect(prompt).toContain('service: definite_failure (service_start_failed) — 退出码 1');
    expect(prompt).toContain('Do not repeat the same failing command or configuration');
  });

  it('omits the section when no earlier round failed', () => {
    expect(buildExecutorContextPrompt(input())).not.toContain('Previous failed round');
  });
});
