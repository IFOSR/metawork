import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { WorkspaceExecutionBindingRepo } from '../../src/storage/workspace-execution-binding-repo.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { WorktreeExecutionCleanupService } from '../../src/execution/worktree-execution-cleanup.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'metawork-worktree-cleanup-'));
  roots.push(root);
  const db = new Database(join(root, 'db.sqlite'));
  runMigrations(db);
  const repo = new TaskRepo(db);
  const store = new WorkspaceStore(join(root, 'workspace-store'));
  const bindings = new WorkspaceExecutionBindingRepo(db);
  const publications = new WorkspacePublicationRepo(db);
  const diagnostics: string[] = [];
  const residues = new Map<string, string[]>();
  repo.insert({
    id: 'task_1',
    title: 'task',
    goal: 'goal',
    status: 'succeeded',
    stateVersion: 3,
    stateDetail: {
      reason: { code: 'completed', message: 'done', evidenceRefs: [] },
      unresolved: [],
      phase: null,
      pendingActions: [],
      requiredWork: [],
      cleanup: { state: 'none', objects: [], reason: '' },
      nextWakeAt: null,
    },
    completedAt: '2026-10-25T00:00:00.000Z',
    archivedAt: null,
    retryOfTaskId: null,
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 1, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    accountId: 'local-default',
    conversationId: 'conversation_1',
    workspaceId: 'workspace_main',
    ownerPlannerSessionId: 'planner_1',
    admittedAt: '2026-10-25T00:00:00.000Z',
    executionMode: 'worktree',
    workspaceExecutionSource: 'planner',
    workspaceDeliveryPolicy: 'auto_publish',
  });
  bindings.upsert({
    taskId: 'task_1',
    generationId: 'generation_1',
    workspaceId: 'workspace_main',
    canonicalPath: join(root, 'project'),
    executionMode: 'worktree',
    authorizedWorkingDirectory: store.planGenerationRoot('task_1', 'generation_1'),
    modeSource: 'planner',
    deliveryPolicy: 'auto_publish',
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
  });
  const generationRoot = store.planGenerationRoot('task_1', 'generation_1');
  mkdirSync(join(generationRoot, 'files'), { recursive: true });
  writeFileSync(join(generationRoot, 'files', 'report.md'), '# candidate');
  const service = new WorktreeExecutionCleanupService({
    workspaceStore: store,
    bindingRepo: bindings,
    subtaskRepo: {
      listByTask: () => [{
        id: 'subtask_1',
        generationId: 'generation_1',
        status: 'done',
      } as never],
    },
    residueReader: { blockingReasons: taskId => residues.get(taskId) ?? [] },
    findTask: taskId => repo.findById(taskId),
    recordDiagnostic: input => {
      diagnostics.push(`${input.kind}:${input.reason}`);
    },
    now: () => '2026-10-25T01:00:00.000Z',
  });
  return { db, store, bindings, publications, repo, service, generationRoot, residues, diagnostics };
}

describe('Worktree execution directory cleanup', () => {
  it('retires the internal execution root of a terminal, residue-free generation', async () => {
    const f = fixture();
    const outcome = await f.service.cleanupTask('task_1');
    expect(outcome.removed).toEqual([{ taskId: 'task_1', generationId: 'generation_1' }]);
    expect(existsSync(f.generationRoot)).toBe(false);
    expect(f.bindings.find('task_1', 'generation_1')?.cleanedAt).toBe('2026-10-25T01:00:00.000Z');
    f.db.close();
  });

  it('keeps the directory while a publication, lease or uncertain state is open', async () => {
    const f = fixture();
    f.residues.set('task_1', ['publication', 'resource_lease']);
    const outcome = await f.service.cleanupTask('task_1');
    expect(outcome.removed).toEqual([]);
    expect(outcome.retained[0]).toMatchObject({ generationId: 'generation_1' });
    expect(outcome.retained[0]!.reasons).toEqual(['publication', 'resource_lease']);
    expect(existsSync(f.generationRoot)).toBe(true);
    expect(f.diagnostics.join('\n')).toContain('cleanup_retained');
    f.db.close();
  });

  it('never touches an in-place binding: there is no internal directory', async () => {
    const f = fixture();
    f.bindings.upsert({
      taskId: 'task_2',
      generationId: 'generation_2',
      workspaceId: 'workspace_main',
      canonicalPath: join(f.generationRoot, 'project'),
      executionMode: 'in_place',
      authorizedWorkingDirectory: join(f.generationRoot, 'project'),
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z',
    });
    const outcome = await f.service.cleanupTask('task_2');
    expect(outcome.removed).toEqual([]);
    expect(outcome.retained).toEqual([]);
    f.db.close();
  });
});
