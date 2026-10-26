import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ArtifactVersionRepo } from '../../src/storage/artifact-version-repo.js';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { WorkspaceChangeRecordRepo } from '../../src/storage/workspace-change-record-repo.js';
import { WorkspaceExecutionBindingRepo } from '../../src/storage/workspace-execution-binding-repo.js';

function database(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('workspace execution persistence', () => {
  it('records the current schema version and exposes the new tables', () => {
    const db = database();
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(59);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'workspace_execution_bindings', 'workspace_change_records', 'artifact_versions',
    ]));
    expect((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
        'execution_mode',
        'workspace_execution_source',
        'workspace_delivery_policy',
        'workspace_target_paths_json',
        'workspace_intent_json',
      ]));
    expect((db.prepare('PRAGMA table_info(workspace_execution_bindings)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
        'mode_source', 'delivery_policy', 'workspace_intent_json', 'targeted_paths_json', 'cleaned_at',
      ]));
    expect((db.prepare('PRAGMA table_info(task_artifacts)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
        'reference_kind', 'workspace_id', 'artifact_version_id', 'source_relative_path',
      ]));
    db.close();
  });

  it('keeps one immutable execution binding per generation', () => {
    const db = database();
    const repo = new WorkspaceExecutionBindingRepo(db);
    const binding = repo.upsert({
      taskId: 'task_1',
      generationId: 'generation_1',
      workspaceId: 'workspace_abc',
      canonicalPath: '/Users/me/project',
      executionMode: 'in_place',
      authorizedWorkingDirectory: '/Users/me/project',
      modeSource: 'planner',
      deliveryPolicy: 'none',
      targetPaths: ['docs/readme.md'],
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    });
    expect(binding.executionMode).toBe('in_place');
    expect(binding.modeSource).toBe('planner');
    expect(binding.targetPaths).toEqual(['docs/readme.md']);
    const second = repo.upsert({
      taskId: 'task_1',
      generationId: 'generation_1',
      workspaceId: 'workspace_abc',
      canonicalPath: '/Users/me/project',
      executionMode: 'worktree',
      authorizedWorkingDirectory: '/tmp/worktree',
      createdAt: '2026-10-23T01:00:00.000Z',
      updatedAt: '2026-10-23T01:00:00.000Z',
    });
    expect(second.executionMode).toBe('in_place');
    expect(repo.find('task_1', 'generation_1')?.authorizedWorkingDirectory).toBe('/Users/me/project');
    expect(repo.find('task_1', 'generation_missing')).toBeNull();
    db.close();
  });

  it('stores bounded change records idempotently by record id', () => {
    const db = database();
    const repo = new WorkspaceChangeRecordRepo(db);
    const record = repo.insert({
      recordId: 'record_1',
      taskId: 'task_1',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      attemptId: 'attempt_1',
      conversationId: 'conv_1',
      workspaceId: 'workspace_abc',
      userTurnId: null,
      beforeTree: null,
      afterTree: null,
      files: [{ path: 'out/deck.pptx', added: 0, deleted: 0, binary: true }],
      totalFiles: 1,
      addedLines: 0,
      deletedLines: 0,
      coverage: 'partial',
      missingReasons: ['shell_unobserved'],
      createdAt: '2026-10-23T00:00:00.000Z',
    });
    expect(record.coverage).toBe('partial');
    expect(record.files).toEqual([{ path: 'out/deck.pptx', added: 0, deleted: 0, binary: true }]);
    const duplicate = repo.insert({ ...record, coverage: 'unavailable', missingReasons: ['snapshot_failed'] });
    expect(duplicate.coverage).toBe('partial');
    expect(repo.findByAttempt('attempt_1')?.recordId).toBe('record_1');
    expect(repo.listByTask('task_1')).toHaveLength(1);
    db.close();
  });

  it('deduplicates artifact versions by workspace path and content', () => {
    const db = database();
    const repo = new ArtifactVersionRepo(db);
    const version = repo.record({
      accountId: 'local-default',
      workspaceId: 'workspace_abc',
      sourceTaskId: 'task_1',
      sourceAttemptId: 'attempt_1',
      relativePath: 'out/deck.pptx',
      contentHash: 'hash_1',
      byteLength: 10,
      objectUri: 'object://sha256/hash_1',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });
    const duplicate = repo.record({
      accountId: 'local-default',
      workspaceId: 'workspace_abc',
      sourceTaskId: 'task_2',
      sourceAttemptId: 'attempt_2',
      relativePath: 'out/deck.pptx',
      contentHash: 'hash_1',
      byteLength: 10,
      objectUri: 'object://sha256/hash_1',
      mediaType: 'application/octet-stream',
    });
    expect(duplicate.artifactVersionId).toBe(version.artifactVersionId);
    expect(repo.findByContent('workspace_abc', 'out/deck.pptx', 'hash_1')?.sourceAttemptId).toBe('attempt_1');
    expect(repo.listByTask('task_1')).toHaveLength(1);
    expect(repo.listByTask('task_2')).toHaveLength(0);
    db.close();
  });
});
