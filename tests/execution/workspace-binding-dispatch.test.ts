import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  executionContextFromBinding,
  workspaceExecutionBindingFingerprint,
} from '../../src/execution/execution-context.js';
import { WorkspaceExecutionBindingRepo } from '../../src/storage/workspace-execution-binding-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workspace execution binding', () => {
  it('keeps the first binding for a generation and fingerprints its facts', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const root = mkdtempSync(join(tmpdir(), 'workspace-binding-'));
    roots.push(root);
    mkdirSync(join(root, 'app'), { recursive: true });
    const repo = new WorkspaceExecutionBindingRepo(db);
    const binding = repo.upsert({
      taskId: 'task_1',
      generationId: 'generation_1',
      workspaceId: 'workspace_1',
      canonicalPath: join(root, 'app'),
      executionMode: 'in_place',
      authorizedWorkingDirectory: join(root, 'app'),
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
    });

    // A second admission for the same generation cannot reinterpret the facts.
    const again = repo.upsert({
      ...binding,
      canonicalPath: '/elsewhere',
      executionMode: 'worktree',
    });
    expect(again.canonicalPath).toBe(binding.canonicalPath);
    expect(again.executionMode).toBe('in_place');

    const fingerprint = workspaceExecutionBindingFingerprint(binding);
    const context = executionContextFromBinding({
      binding,
      taskId: 'task_1',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      configurationRevision: 'revision_1',
      resourceLeaseId: 'resource_lease_1',
    });
    expect(context.executionMode).toBe('in_place');
    expect(context.bindingFingerprint).toBe(fingerprint);
    expect(context.canonicalWorkspacePath).toBe(binding.canonicalPath);

    // Any change to the physical facts produces a different fingerprint.
    expect(workspaceExecutionBindingFingerprint({ ...binding, canonicalPath: '/elsewhere' }))
      .not.toBe(fingerprint);
    db.close();
  });
});
