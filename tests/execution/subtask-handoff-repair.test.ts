import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { SubtaskHandoffRepo } from '../../src/storage/subtask-handoff-repo.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';
import { ExecutorAttemptReceiptRepo } from '../../src/storage/executor-attempt-receipt-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { backfillOutgoingHandoffs } from '../../src/execution/subtask-handoff-repair.js';
import type { Subtask } from '../../src/core/types.js';

const ACCOUNT = 'local-default';
const TASK = 'task_repair';
const GENERATION = 'generation_repair';
const UPSTREAM = 'node_upstream';
const DOWNSTREAM = 'node_downstream';
const ATTEMPT = 'attempt_upstream';

let db: Database.Database;
let subtaskRepo: SubtaskRepo;
let handoffRepo: SubtaskHandoffRepo;
let results: ResultObjectRepo;
let receipts: ExecutorAttemptReceiptRepo;

function subtask(id: string, status: Subtask['status'], dependencies: Subtask['dependencies'] = []): Subtask {
  return {
    id,
    taskId: TASK,
    graphRevision: 1,
    generationId: GENERATION,
    title: id,
    goal: `complete ${id}`,
    status,
    dependencies,
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    executorBindings: [{
      agentClassRef: 'engineer',
      harnessRef: 'pi-cli',
      providerRef: 'provider',
      modelRef: 'default-model',
      permissionProfileRef: 'standard-agent',
      configurationRevision: 'revision-1',
    }],
    deliveryKind: 'report',
    acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
    riskLevel: 'low',
    result: 'upstream body',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: 4 },
    error: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

function repairDeps() {
  return {
    materializer: { accountId: ACCOUNT, subtaskRepo, handoffRepo, results },
    subtaskRepo,
    receiptRepo: receipts,
    results,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO tasks (id, title, goal, status, summary, snapshot_json, resources_json,
      artifacts_json, dependencies_json, priority_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at)
    VALUES (?, 'repair', 'goal', 'needs_action', '', '[]', '[]', '[]', '[]', '{}', '', '', 0, ?, ?)
  `).run(TASK, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z');
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:configuration', 'native', '2026-10-28T00:00:00.000Z')
  `).run();
  new WorkGraphRevisionRepo(db).activate({
    id: 'work_graph_revision_repair_1',
    taskId: TASK,
    revision: 1,
    generationId: GENERATION,
    configurationRevision: 'revision-1',
    authorizedDecisionId: null,
    proposalSource: 'initial',
    automaticReplan: false,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  });
  subtaskRepo = new SubtaskRepo(db);
  handoffRepo = new SubtaskHandoffRepo(db);
  receipts = new ExecutorAttemptReceiptRepo(db);
  results = new ResultObjectRepo(db, mkdtempSync(join(tmpdir(), 'handoff-repair-')));
  subtaskRepo.upsert(subtask(UPSTREAM, 'done'));
  subtaskRepo.upsert(subtask(DOWNSTREAM, 'blocked', [{
    fromSubtaskId: UPSTREAM,
    requiredItems: [{ key: 'outline', type: 'text', description: 'outline' }],
  }]));
});

const BINDING = {
  agentClassRef: 'engineer',
  harnessRef: 'pi-cli',
  providerRef: 'provider',
  modelRef: 'default-model',
  permissionProfileRef: 'standard-agent',
  configurationRevision: 'revision-1',
} as const;

function recordUpstreamDispatch(): void {
  db.prepare(`
    INSERT INTO work_units (id, agent_class_name, agent_class_kind, state,
      claimed_task_id, claimed_subtask_id, claimed_attempt_id, heartbeat_at,
      lease_expires_at, created_at, updated_at)
    VALUES ('work_unit_upstream', 'engineer', 'executor', 'idle', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TASK, UPSTREAM, ATTEMPT,
    '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z',
    '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO kernel_dispatch_items (
      attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
      agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
      attempt_payload_json, resource_grant_json, status, launch_started_at,
      configuration_revision, authorized_binding_json, binding_fingerprint,
      created_at, updated_at
    ) VALUES (?, 'decision_upstream', 0, ?, ?, ?, 'engineer', 'primary', NULL, 'fresh',
      'null', '[]', 'terminal', ?, 'revision-1', ?, 'fingerprint_upstream', ?, ?)
  `).run(
    ATTEMPT, TASK, GENERATION, UPSTREAM,
    '2026-10-28T00:00:00.000Z', JSON.stringify(BINDING),
    '2026-10-28T00:00:00.000Z', '2026-10-28T00:10:00.000Z',
  );
}

function recordUpstreamReceipt(parsing: Record<string, unknown>): void {
  recordUpstreamDispatch();
  receipts.insert({
    attemptId: ATTEMPT,
    executionId: 'execution_upstream',
    taskId: TASK,
    subtaskId: UPSTREAM,
    workUnitId: 'work_unit_upstream',
    agentClassName: 'engineer',
    startedAt: '2026-10-28T00:00:00.000Z',
    completedAt: '2026-10-28T00:10:00.000Z',
    terminalState: 'completed',
    rawResponse: 'upstream body',
    completionSchemaVersion: 4,
    parsing,
    verification: { warnings: [], violations: [] },
    errorCode: null,
    errorDetail: null,
    failure: null,
  });
}

function putSafeProjection(): void {
  results.putObject({
    resultId: 'result_safe_upstream',
    accountId: ACCOUNT,
    taskId: TASK,
    generationId: GENERATION,
    sourceSubtaskId: UPSTREAM,
    attemptId: ATTEMPT,
    kind: 'safe_projection',
    mediaType: 'text/markdown',
    content: 'upstream body',
    completeness: 'complete',
    retentionClass: 'standard',
  });
}

describe('edge handoff backfill', () => {
  it('rebuilds the missing handoff from the upstream certified safe projection', () => {
    putSafeProjection();
    recordUpstreamReceipt({ resultObjects: { safeProjectionId: 'result_safe_upstream' } });

    const result = backfillOutgoingHandoffs(repairDeps(), { taskId: TASK, now: '2026-10-28T01:00:00.000Z' });
    expect(result).toEqual({
      repaired: [{ subtaskId: UPSTREAM, targetSubtaskIds: [DOWNSTREAM] }],
      skipped: [],
    });
    const [handoff] = handoffRepo.listByTask(TASK);
    expect(handoff).toMatchObject({ fromSubtaskId: UPSTREAM, toSubtaskId: DOWNSTREAM, attemptId: ATTEMPT });
    expect(handoff?.resultReference?.resultId).toBe('result_safe_upstream');
  });

  it('is idempotent and reports nothing to repair on a second run', () => {
    putSafeProjection();
    recordUpstreamReceipt({ resultObjects: { safeProjectionId: 'result_safe_upstream' } });
    backfillOutgoingHandoffs(repairDeps(), { taskId: TASK, now: '2026-10-28T01:00:00.000Z' });
    const second = backfillOutgoingHandoffs(repairDeps(), { taskId: TASK, now: '2026-10-28T01:05:00.000Z' });
    expect(second.repaired).toEqual([]);
    expect(handoffRepo.listByTask(TASK)).toHaveLength(1);
  });

  it('reports rather than guesses when the upstream attempt has no safe projection', () => {
    recordUpstreamReceipt({ resultObjects: {} });
    const result = backfillOutgoingHandoffs(repairDeps(), { taskId: TASK, now: '2026-10-28T01:00:00.000Z' });
    expect(result.repaired).toEqual([]);
    expect(result.skipped).toEqual([{
      subtaskId: UPSTREAM,
      reason: 'the certified attempt has no safe projection to hand downstream',
    }]);
    expect(handoffRepo.listByTask(TASK)).toHaveLength(0);
  });
});
