import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { SubtaskHandoffRepo } from '../../src/storage/subtask-handoff-repo.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';
import type { Subtask, Task } from '../../src/core/types.js';
import { seedWorkGraphRevision, testExecutorBinding } from '../support/seed-work-graph.js';

function node(id: string, title: string, dependencies: Subtask['dependencies'] = []): Subtask {
  return {
    id, taskId: 'task_context', title, goal: `private goal for ${title}`, status: 'ready',
    graphRevision: 1, generationId: 'generation_context',
    dependencies, contextRefs: [], requiredCapabilities: ['workspace-engineering'],
    executorBindings: [testExecutorBinding({ configurationRevision: 'revision_context' })], deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

describe('SubtaskExecutionContextBuilder', () => {
  it('injects only direct immutable result references and exposes siblings by identity, not goal', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
        dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at
      ) VALUES ('task_context', 'Task background', 'top-level background only', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
    `).run('2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
    seedWorkGraphRevision(db, { taskId: 'task_context', generationId: 'generation_context', configurationRevision: 'revision_context' });
    const a = node('a', 'A');
    a.status = 'done';
    const b = node('b', 'B', [{ fromSubtaskId: 'a', requiredItems: [{ key: 'summary', type: 'text', description: 'A summary' }] }]);
    const c = node('c', 'C', [{ fromSubtaskId: 'b', requiredItems: [{ key: 'summary', type: 'text', description: 'B summary' }] }]);
    const repo = new SubtaskRepo(db);
    [a, b, c].forEach(subtask => repo.upsert(subtask));
    const resultRepo = new ResultObjectRepo(db, '/tmp/metawork-context-results');
    const result = resultRepo.putObject({
      resultId: 'result_attempt_a_safe',
      accountId: 'local-default',
      taskId: 'task_context',
      generationId: 'generation_context',
      sourceSubtaskId: 'a',
      attemptId: 'attempt_a',
      kind: 'safe_projection',
      mediaType: 'text/markdown',
      content: 'full upstream body that must not be copied into the prompt',
      completeness: 'complete',
      retentionClass: 'task',
    });
    const reference = resultRepo.createReference({
      referenceId: 'reference_a_to_b',
      resultId: result.resultId,
      accountId: 'local-default',
      taskId: 'task_context',
      generationId: 'generation_context',
      sourceSubtaskId: 'a',
      targetSubtaskId: 'b',
      edgeKey: 'a->b',
      requiredItems: ['summary'],
      readScope: {
        kind: 'direct_dependency',
        offset: 0,
        length: result.byteLength,
        summaryHash: 'sha256:summary',
      },
    });
    new SubtaskHandoffRepo(db).insert({
      taskId: 'task_context', fromSubtaskId: 'a', toSubtaskId: 'b', attemptId: 'attempt_a',
      items: [{
        key: 'summary',
        type: 'result_reference',
        referenceId: reference.referenceId,
        summary: 'Authorized upstream result for summary',
      }],
      resultReference: reference,
      completionSchemaVersion: 4, createdAt: '2026-07-17T00:00:01.000Z',
    });
    const task: Task = {
      id: 'task_context', title: 'Task background', goal: 'top-level background only', status: 'running', summary: '',
      snapshots: [], resources: [], artifacts: [], dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
      createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    };

    const built = new SubtaskExecutionContextBuilder(db, {
      accountId: 'local-default',
      resultRoot: '/tmp/metawork-context-results',
    }).build({
      executionId: 'exec', task, subtask: b, allSubtasks: [a, b, c], attemptId: 'attempt_b',
      workUnitId: 'wu', sessionId: 'session',
      workspaceContext: { allowFilesystem: true, workingDirectory: '/repo', targetPaths: ['/repo/out'] },
      evidenceToolsAvailable: false,
    });

    expect(built.context.incomingHandoffs).toHaveLength(1);
    expect(built.context.incomingHandoffs[0]!.items).toEqual([{
      key: 'summary',
      type: 'result_reference',
      referenceId: 'reference_a_to_b',
      summary: 'Authorized upstream result for summary',
    }]);
    expect(built.context.incomingHandoffs[0]!.resultReference).toMatchObject({
      referenceId: 'reference_a_to_b',
      contentHash: result.contentHash,
      byteLength: result.byteLength,
    });
    expect(built.resultReferenceCapability.list().items).toEqual([
      expect.objectContaining({ referenceId: 'reference_a_to_b' }),
    ]);
    expect(built.resultReferenceCapability.get({
      referenceId: 'reference_a_to_b',
      offset: 0,
    }).content).toBe('full upstream body that must not be copied into the prompt');
    expect(built.context.outgoingHandoffRequirements).toEqual([{
      toSubtaskId: 'c', requiredItems: [{ key: 'summary', type: 'text', description: 'B summary' }],
    }]);
    expect(built.context.outOfScopeSiblings).toEqual([{ id: 'a', title: 'A' }, { id: 'c', title: 'C' }]);
    expect(JSON.stringify(built.context.outOfScopeSiblings)).not.toContain('private goal');
    expect(built.context.taskBackground.instruction).toBe('background_only');
  });

  it('fails closed with a structured diagnostic when a handoff points to a missing Result Object', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`
      INSERT INTO tasks (
        id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
        dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
        last_interruption_reason, interruption_count, created_at, updated_at
      ) VALUES ('task_context_missing_result', 'Task', 'Goal', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
    `).run('2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
    seedWorkGraphRevision(db, {
      taskId: 'task_context_missing_result',
      generationId: 'generation_context_missing_result',
      configurationRevision: 'revision_context_missing_result',
    });

    const upstream = node('upstream_missing_result', 'Upstream');
    upstream.taskId = 'task_context_missing_result';
    upstream.generationId = 'generation_context_missing_result';
    upstream.executorBindings = [testExecutorBinding({
      configurationRevision: 'revision_context_missing_result',
    })];
    upstream.status = 'done';
    const downstream = node('downstream_missing_result', 'Downstream', [{
      fromSubtaskId: upstream.id,
      requiredItems: [{ key: 'summary', type: 'text', description: 'summary' }],
    }]);
    downstream.taskId = upstream.taskId;
    downstream.generationId = upstream.generationId;
    downstream.executorBindings = [testExecutorBinding({
      configurationRevision: 'revision_context_missing_result',
    })];
    const subtaskRepo = new SubtaskRepo(db);
    subtaskRepo.upsert(upstream);
    subtaskRepo.upsert(downstream);

    const referenceId = 'missing-result-reference';
    new SubtaskHandoffRepo(db).insert({
      taskId: upstream.taskId,
      fromSubtaskId: upstream.id,
      toSubtaskId: downstream.id,
      attemptId: 'attempt_upstream',
      items: [{
        key: 'summary',
        type: 'result_reference',
        referenceId,
        summary: 'Authorized upstream result',
      }],
      resultReference: {
        referenceId,
        resultId: 'missing-result-object',
        accountId: 'local-default',
        taskId: upstream.taskId,
        generationId: upstream.generationId,
        sourceSubtaskId: upstream.id,
        targetSubtaskId: downstream.id,
        edgeKey: `${upstream.id}->${downstream.id}`,
        requiredItems: ['summary'],
        readScope: {
          kind: 'direct_dependency',
          offset: 0,
          length: 10,
          summaryHash: 'sha256:summary',
        },
        contentHash: 'sha256:missing',
        byteLength: 10,
        mediaType: 'text/plain',
        completeness: 'complete',
        createdAt: '2026-07-17T00:00:01.000Z',
      },
      completionSchemaVersion: 4,
      createdAt: '2026-07-17T00:00:01.000Z',
    });

    const task: Task = {
      id: upstream.taskId,
      title: 'Task',
      goal: 'Goal',
      status: 'running',
      summary: '',
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0,
        blocksOthers: false,
        idleHours: 0,
      },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    expect(() => new SubtaskExecutionContextBuilder(db, {
      accountId: 'local-default',
      resultRoot: '/tmp/metawork-context-results-missing',
    }).build({
      executionId: 'exec',
      task,
      subtask: downstream,
      allSubtasks: [upstream, downstream],
      attemptId: 'attempt_downstream',
      workUnitId: 'wu',
      sessionId: 'session',
      workspaceContext: {
        allowFilesystem: true,
        workingDirectory: '/repo',
        targetPaths: [],
      },
      evidenceToolsAvailable: false,
    })).toThrow('dependency_result_object_missing');
  });
});
