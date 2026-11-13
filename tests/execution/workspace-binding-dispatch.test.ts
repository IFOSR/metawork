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
import { initializeDatabaseSchema } from '../../src/storage/schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workspace execution binding', () => {
  it('keeps a generation binding immutable and fingerprints its facts', () => {
    const db = new Database(':memory:');
    initializeDatabaseSchema(db);
    const root = mkdtempSync(join(tmpdir(), 'workspace-binding-'));
    roots.push(root);
    mkdirSync(join(root, 'app'), { recursive: true });
    const repo = new WorkspaceExecutionBindingRepo(db);
    // This table only ever held the retired single-root mode; it stays readable
    // so recovery can reject those rows explicitly.
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

    // Any change to the physical facts produces a different fingerprint.
    expect(workspaceExecutionBindingFingerprint({ ...binding, canonicalPath: '/elsewhere' }))
      .not.toBe(fingerprint);

    // A retired single-root binding is rejected instead of being reinterpreted
    // as a Conversation Git Attempt.
    expect(() => executionContextFromBinding({
      binding,
      taskId: 'task_1',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      configurationRevision: 'revision_1',
      resourceLeaseId: 'resource_lease_1',
    })).toThrow(/retired/u);
    db.close();
  });
});
