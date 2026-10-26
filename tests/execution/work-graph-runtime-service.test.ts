import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import type { Task } from '../../src/core/types.js';
import { WorkGraphRuntimeService } from '../../src/execution/work-graph-runtime-service.js';
import type { WorkGraphProposal } from '../../src/work-graph/types.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { createEvidenceId, TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';
import { SubtaskExecutionContextBuilder } from '../../src/execution/subtask-execution-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_TASK_STATE_DETAIL } from '../../src/task/task-state.js';

const now = '2026-07-16T00:00:00.000Z';
const configurationRevision = 'configuration_revision_1';

const authorizedBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-cli',
  providerRef: 'openai',
  modelRef: 'gpt-5-codex',
  permissionProfileRef: 'workspace-engineering',
  configurationRevision,
};

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', ?)
  `).run(configurationRevision, 'sha256:test-configuration', now);
  return db;
}

function task(id = 'task_1'): Task {
  return {
    id, title: 'Task', goal: 'Do work', status: 'running', summary: '', snapshots: [],
    stateVersion: 1, stateDetail: EMPTY_TASK_STATE_DETAIL, completedAt: null,
    archivedAt: null, retryOfTaskId: null,
    resources: [], artifacts: [], dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
    createdAt: now, updatedAt: now,
  };
}

function graph(_taskId: string): WorkGraphProposal {
  return {
    schemaVersion: 7,
    configurationRevision,
    reason: 'authorized graph',
    subtasks: [{
      id: 'execute', title: 'Execute', goal: 'Do work', dependencies: [], contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [{
        agentClassRef: 'codex-cli',
        modelSelection: { mode: 'agent-class-default' },
      }],
      deliveryKind: 'edit', acceptance: [{ key: 'tests', description: 'run the unit tests', requiredEvidence: ['test result'] }], riskLevel: 'low',
    }],
  };
}

function seedKernelDecision(db: Database.Database, id: string, taskId: string): void {
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    ) VALUES (?, 2, ?, 'plan_proposed', ?, NULL, 'session_test', ?, NULL, NULL,
      '{}', '{}', '{}', 'authorize_task_plan', 'test authorization', ?, ?, '[]', ?)
  `).run(
    id,
    `event_${id}`,
    taskId,
    taskId,
    configurationRevision,
    JSON.stringify([authorizedBinding]),
    now,
  );
}

function authorizedBindingsBySubtask(
  overrides: Partial<AuthorizedExecutorBinding> = {},
): Record<string, AuthorizedExecutorBinding[]> {
  return {
    execute: [{ ...authorizedBinding, ...overrides }],
  };
}

describe('WorkGraphRuntimeService', () => {
  function service(db: Database.Database): WorkGraphRuntimeService {
    return new WorkGraphRuntimeService(
      new SubtaskRepo(db),
      new TaskEventRepo(db),
      new WorkGraphRevisionRepo(db),
      new TaskExecutionEvidenceRepo(db),
    );
  }

  it('applies follow-up graphs sharing an interaction and rebuilds their selected context on recovery', () => {
    const db = createDb();
    const root = mkdtempSync(join(tmpdir(), 'metawork-followup-graphs-'));
    try {
      new TaskRepo(db).insert(task('source_task'));
      db.prepare(`INSERT INTO interactions (id, task_id, session_id, user_input, system_output, created_at)
        VALUES ('shared_source', 'source_task', 'session_test', 'test number 314159', '', ?)`)
        .run(now);
      const evidenceId = 'evidence_user_interaction_shared_source';
      for (const id of ['followup_b', 'followup_c']) {
        const target = task(id);
        new TaskRepo(db).insert(target);
        seedKernelDecision(db, `decision_${id}`, id);
        const selected = graph(id);
        selected.subtasks[0]!.contextRefs = [{ kind: 'interaction', interactionId: 'shared_source', side: 'user' }];
        expect(service(db).apply({
          task: target, userPrompt: 'Use the previous number', sessionId: 'session_test',
          authorizedWorkGraph: selected, authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
          authorization: { decisionId: `decision_${id}`, generationId: `generation_${id}`,
            revision: 1, source: 'initial', automaticReplan: false },
        }).outcome).toBe('applied');
        expect(new TaskExecutionEvidenceRepo(db).findForTask(id, evidenceId)?.content).toBe('test number 314159');
      }
      // Schema 47 could persist the second graph while retaining only B's association.
      db.prepare('DELETE FROM task_execution_evidence WHERE task_id = ? AND id = ?').run('followup_c', evidenceId);
      for (const id of ['followup_c', 'followup_b', 'followup_c']) {
        const target = new TaskRepo(db).findById(id)!;
        const recovered = service(db).apply({ task: target, userPrompt: 'Continue', authorizedWorkGraph: null });
        expect(recovered.outcome).toBe('recovered');
        if (recovered.outcome !== 'recovered') throw new Error('expected persisted graph');
        const prepared = new SubtaskExecutionContextBuilder(db, { resultRoot: root }).build({
          task: target, subtask: recovered.subtasks[0]!, allSubtasks: recovered.subtasks,
          executionId: 'execution', attemptId: `attempt_${id}`, workUnitId: 'unit', sessionId: 'session_test',
          workspaceContext: { allowFilesystem: false, workingDirectory: root, targetPaths: [] }, evidenceToolsAvailable: true,
        });
        expect(prepared.context.selectedEvidence[0]?.content).toBe('test number 314159');
        prepared.evidenceCapability.revoke();
        prepared.resultReferenceCapability.revoke();
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM task_execution_evidence WHERE id = ?').get(evidenceId)).toEqual({ count: 2 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes only the full Kernel-authorized bindings for a v7 graph revision', () => {
    const db = createDb();
    const taskRecord = task();
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    const repo = new SubtaskRepo(db);
    const result = service(db).apply({
      task: taskRecord, userPrompt: 'ignored by graph materialization', authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: { decisionId: 'decision_initial', generationId: 'generation_1', revision: 1, source: 'initial', automaticReplan: false },
    });

    expect(result).toMatchObject({ outcome: 'applied' });
    if (result.outcome !== 'applied') return;
    expect(result.subtasks[0]).toMatchObject({
      id: `${taskRecord.id}_r1_execute`, graphRevision: 1, generationId: 'generation_1', requiredCapabilities: ['workspace-engineering'],
      executorBindings: [authorizedBinding], deliveryKind: 'edit',
      acceptance: [{ key: 'tests', description: 'run the unit tests', requiredEvidence: ['test result'] }],
    });
    expect(repo.listByTask(taskRecord.id)[0]).toMatchObject({
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [authorizedBinding],
    });
    expect(new WorkGraphRevisionRepo(db).findActive(taskRecord.id)).toMatchObject({
      configurationRevision,
    });
  });

  it('persists historical artifact context refs across graph materialization and reload', () => {
    const db = createDb();
    const taskRecord = task('task_artifact_context');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_artifact_context', taskRecord.id);
    const artifactGraph: WorkGraphProposal = {
      ...graph(taskRecord.id),
      subtasks: [{
        ...graph(taskRecord.id).subtasks[0]!,
        contextRefs: [{ kind: 'artifact', artifactId: 'artifact_history_1' }],
      }],
    };

    const runtime = service(db);
    const applied = runtime.apply({
      task: taskRecord,
      userPrompt: 'continue the historical artifact',
      authorizedWorkGraph: artifactGraph,
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: {
        decisionId: 'decision_artifact_context',
        generationId: 'generation_artifact_context',
        revision: 1,
        source: 'initial',
        automaticReplan: false,
      },
    });

    expect(applied).toMatchObject({ outcome: 'applied' });
    expect(new SubtaskRepo(db).findById(`${taskRecord.id}_r1_execute`)).toMatchObject({
      contextRefs: [{ kind: 'artifact', artifactId: 'artifact_history_1' }],
    });
    expect(runtime.apply({
      task: taskRecord,
      userPrompt: 'recover',
      authorizedWorkGraph: null,
    })).toMatchObject({
      outcome: 'recovered',
      workGraph: {
        subtasks: [{
          contextRefs: [{ kind: 'artifact', artifactId: 'artifact_history_1' }],
        }],
      },
    });
  });

  it('rejects an authorized binding from a different configuration revision', () => {
    const db = createDb();
    const taskRecord = task('task_revision_mismatch');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_revision_mismatch', taskRecord.id);

    expect(service(db).apply({
      task: taskRecord,
      userPrompt: 'apply',
      authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask({
        configurationRevision: 'configuration_revision_2',
      }),
      authorization: {
        decisionId: 'decision_revision_mismatch',
        generationId: 'generation_1',
        revision: 1,
        source: 'initial',
        automaticReplan: false,
      },
    })).toEqual({
      outcome: 'not_executable',
      reason: 'configuration_conflict',
    });
    expect(new SubtaskRepo(db).listByTask(taskRecord.id)).toEqual([]);
    expect(new WorkGraphRevisionRepo(db).findActive(taskRecord.id)).toBeNull();
  });

  it('returns missing_graph and never synthesizes a fallback', () => {
    const db = createDb();
    const taskRecord = task('task_missing');
    new TaskRepo(db).insert(taskRecord);
    const repo = new SubtaskRepo(db);

    expect(service(db).apply({
      task: taskRecord, userPrompt: 'just do it', authorizedWorkGraph: null,
    })).toEqual({ outcome: 'not_executable', reason: 'missing_graph' });
    expect(repo.listByTask(taskRecord.id)).toEqual([]);
  });

  it('projects persisted active work without making an orphan recovery decision', () => {
    const db = createDb();
    const taskRecord = task('task_recover');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    const repo = new SubtaskRepo(db);
    const runtime = service(db);
    expect(runtime.apply({
      task: taskRecord, userPrompt: 'apply', authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: { decisionId: 'decision_initial', generationId: 'generation_1', revision: 1, source: 'initial', automaticReplan: false },
    })).toMatchObject({ outcome: 'applied' });
    repo.updateStatus(`${taskRecord.id}_r1_execute`, 'running', { error: 'previous timeout' });

    const result = runtime.apply({ task: taskRecord, userPrompt: 'resume', authorizedWorkGraph: null });
    expect(result).toMatchObject({ outcome: 'recovered' });
    if (result.outcome !== 'recovered') return;
    expect(result.workGraph).toMatchObject({
      schemaVersion: 7,
      configurationRevision,
      subtasks: [{
        executorBindings: [{
          agentClassRef: authorizedBinding.agentClassRef,
          modelSelection: {
            mode: 'proposed',
            modelRef: authorizedBinding.modelRef,
          },
        }],
      }],
    });
    expect(repo.findById(`${taskRecord.id}_r1_execute`)).toMatchObject({ status: 'running', error: 'previous timeout' });
  });

  it('does not recover historical Subtasks without an active graph revision', () => {
    const db = createDb();
    const taskRecord = task('task_historical');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    const runtime = service(db);
    expect(runtime.apply({
      task: taskRecord,
      userPrompt: 'apply',
      authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: {
        decisionId: 'decision_initial',
        generationId: 'generation_1',
        revision: 1,
        source: 'initial',
        automaticReplan: false,
      },
    })).toMatchObject({ outcome: 'applied' });
    new WorkGraphRevisionRepo(db).complete(taskRecord.id, 1, now);

    expect(runtime.apply({
      task: taskRecord,
      userPrompt: 'resume',
      authorizedWorkGraph: null,
    })).toEqual({ outcome: 'not_executable', reason: 'missing_graph' });
  });

  it('reapplies the same authorized revision without changing in-flight Subtask state', () => {
    const db = createDb();
    const taskRecord = task('task_reapply');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    const repo = new SubtaskRepo(db);
    const runtime = service(db);
    const authorization = {
      decisionId: 'decision_initial', generationId: 'generation_1', revision: 1,
      source: 'initial' as const, automaticReplan: false,
    };
    runtime.apply({
      task: taskRecord, userPrompt: 'apply', authorizedWorkGraph: graph(taskRecord.id), authorization,
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
    });
    repo.updateStatus(`${taskRecord.id}_r1_execute`, 'awaiting_decision', { error: 'waiting for Kernel' });

    expect(runtime.apply({
      task: taskRecord, userPrompt: 'reapply', authorizedWorkGraph: graph(taskRecord.id), authorization,
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
    })).toMatchObject({ outcome: 'recovered' });
    expect(repo.findById(`${taskRecord.id}_r1_execute`)).toMatchObject({
      status: 'awaiting_decision', error: 'waiting for Kernel',
    });
  });

  it('defensively rejects a conflicting revision', () => {
    const db = createDb();
    const taskRecord = task('task_conflict');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    const runtime = service(db);
    runtime.apply({
      task: taskRecord, userPrompt: 'apply', authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: { decisionId: 'decision_initial', generationId: 'generation_1', revision: 1, source: 'initial', automaticReplan: false },
    });

    expect(runtime.apply({
      task: taskRecord, userPrompt: 'replace', authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: { decisionId: 'decision_conflict', generationId: 'generation_1', revision: 3, source: 'replan', automaticReplan: true },
    })).toEqual({
      outcome: 'not_executable', reason: 'revision_conflict',
    });
  });

  it('applies one Kernel-authorized conflict replan as the next revision', () => {
    const db = createDb();
    const taskRecord = task('task_conflict_replan');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    seedKernelDecision(db, 'decision_conflict_replan', taskRecord.id);
    const runtime = service(db);
    runtime.apply({
      task: taskRecord,
      userPrompt: 'initial',
      authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: {
        decisionId: 'decision_initial',
        generationId: 'generation_1',
        revision: 1,
        source: 'initial',
        automaticReplan: false,
      },
    });

    expect(runtime.apply({
      task: taskRecord,
      userPrompt: 'resolve publication conflict',
      authorizedWorkGraph: graph(taskRecord.id),
      authorizedBindingsBySubtask: authorizedBindingsBySubtask(),
      authorization: {
        decisionId: 'decision_conflict_replan',
        generationId: 'generation_1',
        revision: 2,
        source: 'conflict_replan',
        automaticReplan: false,
      },
    })).toMatchObject({ outcome: 'applied' });
    expect(new WorkGraphRevisionRepo(db).findActive(taskRecord.id)).toMatchObject({
      revision: 2,
      proposalSource: 'conflict_replan',
    });
  });

  it('keeps distinct completed nodes with long task IDs and preserves existing evidence references', () => {
    const db = createDb();
    const taskRecord = task(`task_plan_event_${'a'.repeat(80)}`);
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    const runtime = service(db);
    const first = graph(taskRecord.id).subtasks[0]!;
    runtime.apply({ task: taskRecord, userPrompt: 'initial',
      authorizedWorkGraph: { ...graph(taskRecord.id), subtasks: [
        { ...first, id: 'one' }, { ...first, id: 'two' },
      ] }, authorizedBindingsBySubtask: { one: [authorizedBinding], two: [authorizedBinding] },
      authorization: { decisionId: 'decision_initial', generationId: 'generation_1', revision: 1, source: 'initial', automaticReplan: false },
    });
    const subtasks = new SubtaskRepo(db);
    const evidence = new TaskExecutionEvidenceRepo(db);
    for (const name of ['one', 'two']) subtasks.updateStatus(`${taskRecord.id}_r1_${name}`, 'done', { result: name });
    evidence.upsert({ id: 'historical-reference', taskId: taskRecord.id, kind: 'task_evidence',
      sourceId: `${taskRecord.id}_r1_one`, title: 'One', content: 'one' });
    const ids = runtime.materializeCompletedEvidence(taskRecord.id, 1);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('historical-reference');
    expect(runtime.materializeCompletedEvidence(taskRecord.id, 1)).toEqual(ids);
    expect(evidence.listTaskEvidenceByGeneration(taskRecord.id, 'generation_1').map(item => item.sourceId).sort())
      .toEqual([`${taskRecord.id}_r1_one`, `${taskRecord.id}_r1_two`]);
    db.close();
  });

  it('supersedes unfinished work and exposes completed work as immutable task evidence', () => {
    const db = createDb();
    const taskRecord = task('task_replan');
    new TaskRepo(db).insert(taskRecord);
    seedKernelDecision(db, 'decision_initial', taskRecord.id);
    seedKernelDecision(db, 'decision_replan', taskRecord.id);
    const repo = new SubtaskRepo(db);
    const runtime = service(db);
    const firstGraph: WorkGraphProposal = {
      schemaVersion: 7,
      configurationRevision,
      reason: 'initial',
      subtasks: [
        { ...graph(taskRecord.id).subtasks[0]!, id: 'research', title: 'Research' },
        { ...graph(taskRecord.id).subtasks[0]!, id: 'write', title: 'Write', dependencies: [{ fromSubtaskId: 'research', requiredItems: [] }] },
      ],
    };
    runtime.apply({
      task: taskRecord, userPrompt: 'initial', authorizedWorkGraph: firstGraph,
      authorizedBindingsBySubtask: {
        research: [authorizedBinding],
        write: [authorizedBinding],
      },
      authorization: { decisionId: 'decision_initial', generationId: 'generation_1', revision: 1, source: 'initial', automaticReplan: false },
    });
    repo.updateStatus('task_replan_r1_research', 'done', { result: 'Verified facts', artifacts: ['report.md'] });

    const evidenceId = createEvidenceId('task_evidence', 'task_replan_r1_task_replan_r1_research');
    const replacement: WorkGraphProposal = {
      schemaVersion: 7,
      configurationRevision,
      reason: 'remaining work',
      subtasks: [{
        ...graph(taskRecord.id).subtasks[0]!, id: 'finish', title: 'Finish',
        contextRefs: [{ kind: 'task_evidence', evidenceId }],
      }],
    };
    const result = runtime.apply({
      task: taskRecord, userPrompt: 'replan', authorizedWorkGraph: replacement,
      authorizedBindingsBySubtask: {
        finish: [authorizedBinding],
      },
      authorization: { decisionId: 'decision_replan', generationId: 'generation_1', revision: 2, source: 'replan', automaticReplan: true },
    });

    expect(result).toMatchObject({ outcome: 'applied' });
    expect(repo.findById('task_replan_r1_research')).toMatchObject({ status: 'done', result: 'Verified facts' });
    expect(repo.findById('task_replan_r1_write')).toMatchObject({ status: 'cancelled' });
    expect(repo.listActiveByTask(taskRecord.id)).toEqual([
      expect.objectContaining({ id: 'task_replan_r2_finish', graphRevision: 2, generationId: 'generation_1' }),
    ]);
    expect(new TaskExecutionEvidenceRepo(db).findForTask(taskRecord.id, evidenceId)).toMatchObject({
      kind: 'task_evidence', source_id: 'task_replan_r1_research',
    });
    expect(new WorkGraphRevisionRepo(db).find(taskRecord.id, 1)).toMatchObject({ status: 'superseded' });
    expect(new WorkGraphRevisionRepo(db).findActive(taskRecord.id)).toMatchObject({ revision: 2, automaticReplan: true });
  });
});
