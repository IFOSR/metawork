import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { ExecutorAttemptReceiptRepo } from '../../src/storage/executor-attempt-receipt-repo.js';
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { ExecutionProjector } from '../../src/management/execution-projector.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { SqliteQueryContextStore } from '../../src/storage/query-usage-context-repo.js';

it('batches timeline facts with constant SQL count and preserves the canonical projection', () => {
  const queries: string[] = [];
  const db = new Database(':memory:', { verbose: sql => queries.push(String(sql)) });
  try {
    runMigrations(db);
    const tasks = new TaskRepo(db);
    const projector = new ExecutionProjector({
      subtaskRepo: new SubtaskRepo(db), receiptRepo: new ExecutorAttemptReceiptRepo(db),
      decisionRepo: new KernelDecisionRepo(db), dispatchItemRepo: new KernelDispatchItemRepo(db),
      attemptRuntimeRepo: new ExecutorAttemptRuntimeRepo(db), publicationRepo: new WorkspacePublicationRepo(db),
    });
    for (let n = 0; n < 10; n += 1) db.prepare(`
      INSERT INTO tasks (id, title, account_id, created_at, updated_at)
      VALUES (?, 'History', 'local-default', 'now', 'now')
    `).run(`task_${n}`);
    for (let n = 0; n < 10; n += 1) db.prepare(`
      INSERT INTO subtasks (id, task_id, title, goal, required_capabilities_json,
        executor_bindings_json, created_at, updated_at)
      VALUES (?, ?, 'Subtask', '', '[]', '[]', 'now', 'now')
    `).run(`sub_${n}`, `task_${n}`);
    const selected = Array.from({ length: 10 }, (_, n) => tasks.findById(`task_${n}`)!);
    expect(tasks.findByIds('local-default', selected.map(task => task.id))).toEqual(selected);
    expect(tasks.findByIds('other-account', selected.map(task => task.id))).toEqual([]);
    expect(new TaskArtifactRepo(db).listByTasks('local-default', selected.map(task => task.id))).toEqual([]);
    expect(new SqliteQueryContextStore(db).taskIdsForTurns('local-default', ['missing'])).toEqual(new Map());
    const expected = selected.map(task => projector.project(task));
    queries.length = 0;
    const many = projector.projectMany(selected);
    const count = queries.filter(sql => /^\s*(SELECT|WITH)\b/i.test(sql)).length;
    expect([...many.values()]).toEqual(expected);
    queries.length = 0;
    projector.projectMany(selected.slice(0, 1));
    expect(queries.filter(sql => /^\s*(SELECT|WITH)\b/i.test(sql))).toHaveLength(count);
    expect(count).toBeLessThanOrEqual(6);
    queries.length = 0;
    expect(projector.projectMany([]).size).toBe(0);
    expect(queries).toEqual([]);
  } finally { db.close(); }
});

const UNUSED_PAYLOAD = `TIMELINE_UNUSED_PAYLOAD_${'x'.repeat(8192)}`;

function populatedFixture() {
  const queries: string[] = [];
  const db = new Database(':memory:', { verbose: sql => queries.push(String(sql)) });
  runMigrations(db);
  const repos = {
    subtaskRepo: new SubtaskRepo(db), receiptRepo: new ExecutorAttemptReceiptRepo(db),
    decisionRepo: new KernelDecisionRepo(db), dispatchItemRepo: new KernelDispatchItemRepo(db),
    attemptRuntimeRepo: new ExecutorAttemptRuntimeRepo(db), publicationRepo: new WorkspacePublicationRepo(db),
  };
  const binding: AuthorizedExecutorBinding = {
    agentClassRef: 'dispatch-agent', harnessRef: 'cli', providerRef: 'provider', modelRef: 'model',
    permissionProfileRef: 'workspace', configurationRevision: 'timeline-config',
  };
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('timeline-config', 'timeline-hash', 'native', 'now')`).run();
  db.prepare(`INSERT INTO work_units (id, agent_class_name, agent_class_kind, created_at, updated_at)
    VALUES ('timeline-work-unit', 'receipt-agent', 'executor', 'now', 'now')`).run();
  const insertTask = db.prepare(`INSERT INTO tasks (id, title, status, account_id, created_at, updated_at)
    VALUES (?, ?, ?, 'local-default', 'now', 'now')`);
  const insertSubtask = db.prepare(`INSERT INTO subtasks
    (id, task_id, title, goal, status, dependencies_json, required_capabilities_json,
     executor_bindings_json, context_refs_json, acceptance_json, result, verification_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 'now')`);
  const insertDispatch = db.prepare(`INSERT INTO kernel_dispatch_items
    (attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id, agent_class_name,
     attempt_kind, recovery_mode, attempt_payload_json, resource_grant_json, status,
     configuration_revision, authorized_binding_json, binding_fingerprint, launch_started_at,
     error_summary, created_at, updated_at)
    VALUES (?, 'decision', ?, ?, 'generation', ?, 'dispatch-agent', ?, 'fresh', ?, ?, ?,
     'timeline-config', ?, 'fingerprint', ?, ?, ?, ?)`);
  const insertReceipt = db.prepare(`INSERT INTO executor_attempt_receipts
    (attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
     started_at, completed_at, terminal_state, raw_response, parsing_json, verification_json,
     attempt_kind, configuration_revision, authorized_binding_json, binding_fingerprint, error_code, error_detail)
    VALUES (?, 'execution', ?, ?, 'timeline-work-unit', 'receipt-agent', 'start', ?, ?, ?, ?, ?, ?,
     'timeline-config', ?, 'fingerprint', ?, ?)`);
  const insertDecision = db.prepare(`INSERT INTO kernel_decisions
    (id, schema_version, event_id, event_type, correlation_id, session_id, task_id, subtask_id,
     event_json, snapshot_json, decision_json, action, reason, configuration_revision, created_at)
    VALUES (?, 5, ?, 'task_tick', 'correlation', 'session', ?, ?, ?, ?, ?, 'dispatch_batch', ?, 'timeline-config', ?)`);
  const kinds = ['primary', 'continuation', 'fallback', 'contract_correction', 'merge_repair'] as const;
  const terminals = ['completed', 'uncertified_result', 'contract_blocked', 'executor_failed',
    'heartbeat_lost', 'cancelled_or_stale'] as const;
  const statuses = ['done', 'awaiting_integration', 'blocked', 'cancelled', 'running',
    'awaiting_decision', 'ready', 'running', 'done', 'running'] as const;
  const dispatchStatuses = ['terminal', 'pending_launch', 'uncertain', 'cancelled', 'running',
    'launching', 'cancelling', 'running', 'terminal', 'running'] as const;
  const progressHistory = Array.from({ length: 75 }, (_, n) => ({
    kind: 'status', text: n === 74 ? 'Executor completed workspace command: cat /tmp/private.txt' : `step ${n}`,
    occurredAt: `progress_${n}`, detail: 'preserved history field',
  }));
  for (let n = 0; n < 10; n += 1) {
    const taskId = `populated_${n}`;
    const subtaskId = `${taskId}_main`;
    insertTask.run(taskId, `Timeline ${n}`, n === 8 ? 'done' : 'running');
    for (const [index, suffix] of ['main', 'receipt_only', 'unstarted'].entries()) {
      insertSubtask.run(`${taskId}_${suffix}`, taskId, `${suffix} ${n}`, UNUSED_PAYLOAD,
        index === 0 ? statuses[n] : 'done',
        JSON.stringify(index === 0 ? [] : [{ fromSubtaskId: subtaskId, requiredItems: [UNUSED_PAYLOAD] }]),
        JSON.stringify([{ ...binding, agentClassRef: 'subtask-agent' }, binding]),
        JSON.stringify([UNUSED_PAYLOAD]), JSON.stringify([UNUSED_PAYLOAD]), UNUSED_PAYLOAD,
        JSON.stringify({ warnings: [UNUSED_PAYLOAD] }), `created_${index}`);
    }
    for (let attempt = 0; attempt < 26; attempt += 1) {
      const attemptId = `${taskId}_attempt_${String(attempt).padStart(2, '0')}`;
      const receiptOnly = attempt === 25;
      const kind = kinds[attempt % kinds.length];
      if (!receiptOnly) insertDispatch.run(attemptId, attempt, taskId, subtaskId, kind,
        JSON.stringify({ goal: UNUSED_PAYLOAD }), JSON.stringify([UNUSED_PAYLOAD]),
        attempt === 24 ? dispatchStatuses[n] : 'terminal', JSON.stringify(binding),
        attempt === 24 ? null : `launched_${attempt}`, attempt === 24 ? 'dispatch failure' : null,
        `created_${attempt}`, `dispatch_updated_${attempt}`);
      if (attempt !== 24) insertReceipt.run(attemptId, taskId, receiptOnly ? `${taskId}_receipt_only` : subtaskId,
        `completed_${String(attempt).padStart(2, '0')}`, terminals[attempt % terminals.length], UNUSED_PAYLOAD,
        JSON.stringify({ diagnostic: UNUSED_PAYLOAD }),
        JSON.stringify({
          warnings: [UNUSED_PAYLOAD],
          ...(n === 3 ? {} : { violations: n === 2 && attempt === 0 ? [{ description: UNUSED_PAYLOAD }] : [] }),
        }),
        kind, JSON.stringify({ ...binding, agentClassRef: 'receipt-agent' }),
        attempt % 2 ? 'error_code' : null, attempt % 3 ? null : 'receipt detail');
      repos.attemptRuntimeRepo.start({
        attemptId, sourceAttemptId: null, workspaceRoot: '/workspace',
        workspaceBaseline: { files: UNUSED_PAYLOAD }, recoverySafety: 'workspace_reconcilable', now: 'runtime_updated',
      });
      repos.attemptRuntimeRepo.recordWorkspaceDelta(attemptId, { files: UNUSED_PAYLOAD }, 'runtime_updated');
      repos.attemptRuntimeRepo.recordProgress(attemptId, {
        kind: 'status', text: 'Executor started workspace command: cat /tmp/private.txt',
        occurredAt: 'progress_now', history: progressHistory, diagnostics: { body: UNUSED_PAYLOAD },
      }, 'runtime_updated');
    }
    for (let decision = 0; decision < 205; decision += 1) {
      const id = `${taskId}_decision_${String(decision).padStart(3, '0')}`;
      const unused = JSON.stringify({ schemaVersion: 5, body: UNUSED_PAYLOAD });
      insertDecision.run(id, `event_${id}`, taskId, decision % 2 ? null : subtaskId,
        unused, unused, unused, `reason ${decision}`, `created_${String(decision).padStart(3, '0')}`);
    }
    const publicationStatuses = n === 0 ? ['integrated', 'pending']
      : n === 1 ? ['conflicted'] : n === 3 ? ['cancelled'] : n === 4 ? ['parked'] : n === 5 ? ['uncertain'] : [];
    for (const [index, status] of publicationStatuses.entries()) {
      db.prepare(`INSERT INTO workspace_publications
        (id, task_id, generation_id, subtask_id, source_attempt_id, agent_class_name, candidate_commit,
         original_completion_json, topology_layer, first_dispatch_order, status, created_at, updated_at)
        VALUES (?, ?, 'generation', ?, 'attempt', 'agent', 'commit', ?, 0, 0, ?, 'now', 'now')`)
        .run(`${taskId}_publication_${index}`, taskId, index === 0 ? subtaskId : `${taskId}_receipt_only`,
          JSON.stringify({ body: UNUSED_PAYLOAD }), status);
    }
  }
  const taskRepo = new TaskRepo(db);
  db.prepare(`UPDATE tasks SET status = 'blocked', dependencies_json = ? WHERE id = 'populated_7'`)
    .run(JSON.stringify([{
      taskId: 'populated_7', type: 'kernel_retry', description: 'retry', status: 'waiting', createdAt: 'now',
    }]));
  const tasks = Array.from({ length: 10 }, (_, n) => taskRepo.findById(`populated_${n}`)!);
  return { db, queries, tasks, repos, projector: new ExecutionProjector(repos) };
}

it('projects narrow Task reads with canonical lifecycle semantics in seven queries for one or ten Tasks', () => {
  const { db, queries, tasks, projector } = populatedFixture();
  try {
    const taskRepo = new TaskRepo(db);
    const canonical = tasks.map(task => projector.project(task));
    expect(canonical[7]!.status).toBe('waiting_retry');
    db.exec(`UPDATE tasks SET snapshot_json = 'unused-invalid', resources_json = 'unused-invalid',
      artifacts_json = 'unused-invalid', priority_json = 'unused-invalid', injected_prefs_json = 'unused-invalid'`);
    for (const count of [1, 10]) {
      queries.length = 0;
      const narrow = taskRepo.findTimelineByIds('local-default', tasks.slice(0, count).map(task => task.id));
      expect([...projector.projectMany(narrow).values()]).toEqual(canonical.slice(0, count));
      const reads = queries.filter(sql => /^\s*(SELECT|WITH)\b/i.test(sql));
      expect(reads).toHaveLength(7);
      expect(reads.some(sql => /\bSELECT\s+(?:\w+\.)?\*/i.test(sql))).toBe(false);
    }
  } finally { db.close(); }
});

it('reads narrow columns in six queries for both one and ten populated canonical timelines', () => {
  const { db, queries, tasks, projector } = populatedFixture();
  try {
    const canonical = tasks.map(task => projector.project(task));
    expect(canonical[0]!.stages[2]!.subtasks?.[0]?.attempts).toHaveLength(20);
    expect(canonical[0]!.stages[2]!.subtasks?.[0]?.attempts[0]?.progressHistory).toHaveLength(50);
    expect(canonical[0]!.stages[1]!.decisions).toHaveLength(200);
    expect(canonical[0]!.stages[1]!.decisions?.[0]?.reason).toBe('reason 5');
    expect(canonical[0]!.stages[4]!.status).toBe('done');
    expect(canonical[1]!.stages[4]!.status).toBe('blocked');
    // Even a violation on an attempt outside the displayed last twenty still matters.
    expect(canonical[2]!.stages[3]!.status).toBe('failed');
    expect(canonical[7]!.status).toBe('waiting_retry');
    for (const count of [1, 10]) {
      queries.length = 0;
      const result = projector.projectMany(tasks.slice(0, count));
      expect([...result.values()]).toEqual(canonical.slice(0, count));
      const reads = queries.filter(sql => /^\s*(SELECT|WITH)\b/i.test(sql));
      expect(reads).toHaveLength(6);
      expect(reads.some(sql => /\bSELECT\s+(?:\w+\.)?\*/i.test(sql))).toBe(false);
    }
  } finally { db.close(); }
});

it('does not deserialize unused baseline, delta, verification, binding or execution bodies', () => {
  const { db, tasks, projector } = populatedFixture();
  const parse = vi.spyOn(JSON, 'parse');
  try {
    const many = projector.projectMany(tasks);
    expect(many.size).toBe(10);
    expect(parse.mock.calls.some(([raw]) => String(raw).includes('TIMELINE_UNUSED_PAYLOAD_'))).toBe(false);
  } finally { parse.mockRestore(); db.close(); }
});

it('keeps unused malformed bodies outside the timeline read boundary', () => {
  const { db, tasks, projector } = populatedFixture();
  try {
    const canonical = tasks.map(task => projector.project(task));
    db.exec(`
      UPDATE subtasks SET context_refs_json = 'unused-invalid', acceptance_json = 'unused-invalid';
      UPDATE executor_attempt_runtime SET workspace_baseline_json = 'unused-invalid', workspace_delta_json = 'unused-invalid';
      UPDATE kernel_dispatch_items SET attempt_payload_json = 'unused-invalid', resource_grant_json = 'unused-invalid';
    `);
    expect([...projector.projectMany(tasks).values()]).toEqual(canonical);
  } finally { db.close(); }
});

it('bounds timeline readers and skips empty task sets without issuing SQL', () => {
  const { db, queries, repos } = populatedFixture();
  try {
    const readers = [repos.subtaskRepo, repos.receiptRepo, repos.dispatchItemRepo, repos.attemptRuntimeRepo];
    queries.length = 0;
    for (const repo of readers) {
      expect(repo.listTimelineByTasks([])).toEqual([]);
      expect(() => repo.listTimelineByTasks(Array.from({ length: 101 }, (_, n) => `task_${n}`)))
        .toThrow('timeline_task_limit');
    }
    expect(queries).toEqual([]);
  } finally { db.close(); }
});

it('retains dispatch AgentClass identity validation in the narrow reader', () => {
  const { db, repos } = populatedFixture();
  try {
    db.prepare(`UPDATE kernel_dispatch_items SET agent_class_name = 'mismatched'
      WHERE attempt_id = 'populated_0_attempt_00'`).run();
    expect(() => repos.dispatchItemRepo.listTimelineByTasks(['populated_0']))
      .toThrow('persisted dispatch AgentClass projection mismatch: populated_0_attempt_00');
  } finally { db.close(); }
});
