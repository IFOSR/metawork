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
import { TaskExecutionEvidenceRepo } from '../../src/execution/execution-evidence-port.js';

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
    resources: [], artifacts: [], dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
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

    const evidenceId = 'evidence_task_evidence_task_replan_r1_task_replan_r1_research';
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
