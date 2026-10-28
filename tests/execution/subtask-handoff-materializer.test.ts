import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { SubtaskHandoffRepo } from '../../src/storage/subtask-handoff-repo.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';
import type { Subtask } from '../../src/core/types.js';
import {
  EdgeHandoffMaterializationError,
  assertEdgeHandoffsMaterializable,
  materializeOutgoingHandoffs,
  outgoingHandoffTargets,
  type EdgeHandoffContext,
  type EdgeHandoffMaterializerDeps,
} from '../../src/execution/subtask-handoff-materializer.js';

const ACCOUNT = 'local-default';
const TASK = 'task_edges';
const GENERATION = 'generation_edges';
const ATTEMPT = 'attempt_upstream';

let db: Database.Database;
let subtaskRepo: SubtaskRepo;
let handoffRepo: SubtaskHandoffRepo;
let results: ResultObjectRepo;
let deps: EdgeHandoffMaterializerDeps;

function subtask(id: string, dependencies: Subtask['dependencies'] = []): Subtask {
  return {
    id,
    taskId: TASK,
    graphRevision: 1,
    generationId: GENERATION,
    title: id,
    goal: `complete ${id}`,
    status: 'ready',
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
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

function context(overrides: Partial<EdgeHandoffContext> = {}): EdgeHandoffContext {
  return {
    taskId: TASK,
    subtaskId: 'node_a',
    generationId: GENERATION,
    attemptId: ATTEMPT,
    completionSchemaVersion: 4,
    declaredHandoffs: [],
    ...overrides,
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
    VALUES (?, 'edges', 'goal', 'running', '', '[]', '[]', '[]', '[]', '{}', '', '', 0, ?, ?)
  `).run(TASK, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z');
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:configuration', 'native', '2026-10-28T00:00:00.000Z')
  `).run();
  new WorkGraphRevisionRepo(db).activate({
    id: 'work_graph_revision_edges_1',
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
  results = new ResultObjectRepo(db, mkdtempSync(join(tmpdir(), 'handoff-materializer-')));
  deps = { accountId: ACCOUNT, subtaskRepo, handoffRepo, results };

  subtaskRepo.upsert(subtask('node_a'));
  subtaskRepo.upsert(subtask('node_b', [{
    fromSubtaskId: 'node_a',
    requiredItems: [
      { key: 'outline', type: 'text', description: 'outline' },
      { key: 'sources', type: 'text', description: 'sources' },
    ],
  }]));
});

function safeProjection(content = 'upstream body'): { resultId: string; byteLength: number } {
  results.putObject({
    resultId: 'result_safe_upstream',
    accountId: ACCOUNT,
    taskId: TASK,
    generationId: GENERATION,
    sourceSubtaskId: 'node_a',
    attemptId: ATTEMPT,
    kind: 'safe_projection',
    mediaType: 'text/markdown',
    content,
    completeness: 'complete',
    retentionClass: 'standard',
  });
  return { resultId: 'result_safe_upstream', byteLength: Buffer.byteLength(content, 'utf8') };
}

describe('outgoing edge handoff materialization', () => {
  it('lists every outgoing edge with its declared requirement keys', () => {
    expect(outgoingHandoffTargets(subtaskRepo, TASK, 'node_a')).toEqual([{
      toSubtaskId: 'node_b',
      requiredKeys: ['outline', 'sources'],
      requiredTypes: ['text', 'text'],
    }]);
    expect(outgoingHandoffTargets(subtaskRepo, TASK, 'node_b')).toEqual([]);
  });

  it('writes the handoff and its result reference for a completed upstream node', () => {
    const projection = safeProjection();
    const inserted = materializeOutgoingHandoffs(deps, context(), projection, '2026-10-28T01:00:00.000Z');
    expect(inserted).toBe(1);
    const [handoff] = handoffRepo.listByTask(TASK);
    expect(handoff).toMatchObject({
      fromSubtaskId: 'node_a',
      toSubtaskId: 'node_b',
      attemptId: ATTEMPT,
    });
    expect(handoff?.items.map(item => item.key)).toEqual(['outline', 'sources']);
    expect(handoff?.items.every(item => item.type === 'result_reference')).toBe(true);
    expect(handoff?.resultReference).toMatchObject({
      resultId: 'result_safe_upstream',
      sourceSubtaskId: 'node_a',
      targetSubtaskId: 'node_b',
      readScope: { kind: 'direct_dependency', length: projection.byteLength },
    });
    expect(results.findReference(handoff!.resultReference!.referenceId)).not.toBeNull();
  });

  it('is idempotent across replayed completions', () => {
    const projection = safeProjection();
    materializeOutgoingHandoffs(deps, context(), projection, '2026-10-28T01:00:00.000Z');
    const second = materializeOutgoingHandoffs(deps, context(), projection, '2026-10-28T01:05:00.000Z');
    expect(second).toBe(0);
    expect(handoffRepo.listByTask(TASK)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM result_references').get()).toEqual({ count: 1 });
  });

  it('refuses to complete a node that owes an edge but has no safe body', () => {
    expect(() => materializeOutgoingHandoffs(deps, context(), null, '2026-10-28T01:00:00.000Z'))
      .toThrow(EdgeHandoffMaterializationError);
    expect(() => assertEdgeHandoffsMaterializable(deps, context(), null))
      .toThrow(/no safe body/);
    expect(handoffRepo.listByTask(TASK)).toHaveLength(0);
  });

  it('does not require a body when the node has no outgoing edge', () => {
    expect(() => assertEdgeHandoffsMaterializable(deps, context({ subtaskId: 'node_b' }), null))
      .not.toThrow();
    expect(materializeOutgoingHandoffs(deps, context({ subtaskId: 'node_b' }), null, '2026-10-28T01:00:00.000Z'))
      .toBe(0);
  });

  it('uses declared artifact items instead of synthesizing text references', () => {
    const projection = safeProjection();
    materializeOutgoingHandoffs(deps, context({
      declaredHandoffs: [{
        toSubtaskId: 'node_b',
        items: [{
          key: 'outline',
          type: 'artifact',
          paths: ['report/outline.pdf'],
        }],
      }],
    }), projection, '2026-10-28T01:00:00.000Z');
    const [handoff] = handoffRepo.listByTask(TASK);
    expect(handoff?.items).toEqual([{
      key: 'outline',
      type: 'artifact',
      paths: ['report/outline.pdf'],
    }]);
  });
});
