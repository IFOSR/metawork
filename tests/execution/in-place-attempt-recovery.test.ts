import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPublicDelivery } from '../../src/delivery/public-delivery-view.js';
import { parseWorkspaceDelta } from '../../src/execution/workspace-change-tracker.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

let root: string;
let workspace: string;
let store: WorkspaceStore;
let db: Database.Database;

const identity = { taskId: 'task_1', generationId: 'generation_1', subtaskId: 'subtask_1' };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'in-place-store-'));
  workspace = await mkdtemp(join(tmpdir(), 'in-place-workspace-'));
  store = new WorkspaceStore(join(root, 'workspace-store'));
  await store.initialize();
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe('in-place attempt recovery facts', () => {
  it('binds the real Workspace and keeps attempt-owned storage disposable', async () => {
    const handle = await store.bindInPlaceWorkspace(identity, workspace);
    expect(handle.kind).toBe('in_place');
    expect(handle.filesPath).toBe(workspace);
    expect(handle.rootPath.startsWith(root)).toBe(true);
    for (const directory of ['inputs', 'handoffs', 'results']) {
      expect(existsSync(join(handle.rootPath, directory))).toBe(true);
    }

    // The Executor writes into the user's Workspace...
    await mkdir(join(workspace, 'out'), { recursive: true });
    await writeFile(join(workspace, 'out', 'deck.pptx'), 'pptx');

    // ...and reclaiming attempt-owned storage never removes those bytes.
    await store.removeWorkspaceUri(pathToFileURL(handle.rootPath).href);
    expect(existsSync(handle.rootPath)).toBe(false);
    expect(await readFile(join(workspace, 'out', 'deck.pptx'), 'utf8')).toBe('pptx');
  });

  it('leaves observable change facts when the process dies before a receipt', async () => {
    const repo = new ExecutorAttemptRuntimeRepo(db);
    const handle = await store.bindInPlaceWorkspace(identity, workspace);
    repo.start({
      attemptId: 'attempt_1',
      sourceAttemptId: null,
      workspaceRoot: handle.filesPath,
      workspaceBaseline: { kind: 'git_status_v1', paths: {}, truncated: false },
      recoverySafety: 'workspace_reconcilable',
      now: '2026-10-24T00:00:00.000Z',
    });
    // A crash after the write and before the terminal receipt looks like this:
    // durable progress and delta, no receipt, workspace bytes still present.
    repo.recordWorkspaceDelta('attempt_1', {
      kind: 'git_status_delta_v1',
      changed: [{ path: 'out/deck.pptx', beforeHash: null, afterHash: 'hash' }],
      baselineTruncated: false,
      finalTruncated: false,
    }, '2026-10-24T00:00:01.000Z');

    const runtime = repo.find('attempt_1');
    expect(runtime?.workspaceRoot).toBe(workspace);
    expect(parseWorkspaceDelta(runtime?.workspaceDelta)).toMatchObject({
      changed: [{ path: 'out/deck.pptx' }],
    });
    const receipts = db.prepare('SELECT count(*) c FROM executor_attempt_receipts WHERE attempt_id = ?')
      .get('attempt_1') as { c: number };
    expect(receipts.c).toBe(0);
  });

  it('reports an in-place delivery failure without pretending to own a copy tree', () => {
    const view = projectPublicDelivery({
      task: { id: 'task_1', executionMode: 'in_place' },
      workspace,
      pendingDecision: false,
      artifacts: [],
      publications: [{ id: 'p1', subtaskId: 's1', createdAt: '2026-10-24T00:00:00.000Z', status: 'conflicted' } as never],
      delivery: () => null,
    });
    expect(view).toMatchObject({ mode: 'in_place', taskDirectory: null, legacy: false, state: 'failed' });
  });
});
