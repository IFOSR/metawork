import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskArtifactRepo, hashContent } from '../../src/storage/task-artifact-repo.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRepo(taskIds: string[] = ['task_a']) {
  const root = mkdtempSync(join(tmpdir(), 'anyfusion-task-artifact-repo-'));
  roots.push(root);
  const db = new Database(':memory:');
  runMigrations(db);
  for (const taskId of taskIds) {
    db.prepare(`
      INSERT INTO tasks (id, title, goal, status, summary, snapshot_json, resources_json,
        dependencies_json, injected_prefs_json, created_at, updated_at)
      VALUES (?, ?, '', 'created', '', '[]', '[]', '[]', '[]',
        '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
    `).run(taskId, taskId);
  }
  return { db, repo: new TaskArtifactRepo(db) };
}

describe('TaskArtifactRepo', () => {
  it('inserts records with stable ids and round-trips through projection without internal paths', () => {
    const { repo } = createRepo();
    const record = repo.insert({
      accountId: 'local-default',
      taskId: 'task_a',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      publicationId: 'publication_1',
      displayName: 'report.md',
      relativePath: 'report.md',
      publishedPath: '/tmp/anywhere/metaclaw-tasks/x/report.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown',
      contentHash: hashContent(Buffer.from('# report')),
      byteLength: 8,
      now: '2026-08-24T01:00:00.000Z',
    });

    expect(record.artifactId).toMatch(/^artifact_/u);
    const found = repo.findById(record.artifactId);
    expect(found?.status).toBe('published');

    const projection = repo.toProjection(found!);
    expect(projection).toEqual({
      artifactId: record.artifactId,
      taskId: 'task_a',
      publicationId: 'publication_1',
      displayName: 'report.md',
      relativePath: 'report.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown',
      previewable: true,
      byteLength: 8,
      contentHash: record.contentHash,
      publishedAt: '2026-08-24T01:00:00.000Z',
    });
    // published_path 绝不能进入 Web projection。
    expect(JSON.stringify(projection)).not.toContain('publishedPath');
    expect(JSON.stringify(projection)).not.toContain('/tmp/anywhere');
  });

  it('enforces the unique identity constraint on (account, task, relative path, hash)', () => {
    const { db, repo } = createRepo();
    const base = {
      accountId: 'local-default',
      taskId: 'task_a',
      generationId: null,
      subtaskId: null,
      publicationId: null,
      displayName: 'same.md',
      relativePath: 'same.md',
      publishedPath: '/tmp/anywhere/same.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown' as const,
      contentHash: 'sha256:same',
      byteLength: 4,
      now: '2026-08-24T01:00:00.000Z',
    };
    repo.insert(base);
    expect(() => repo.insert({ ...base })).toThrow(/UNIQUE/u);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_artifacts').get()).toEqual({ n: 1 });
  });

  it('finds by relative path + hash, lists by task and by publication, and marks unavailability', () => {
    const { repo } = createRepo(['task_a', 'task_b']);
    const first = repo.insert({
      accountId: 'local-default',
      taskId: 'task_a',
      publicationId: 'publication_1',
      displayName: 'a.md',
      relativePath: 'a.md',
      publishedPath: '/tmp/a.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown',
      contentHash: 'sha256:a1',
      byteLength: 2,
      now: '2026-08-24T01:00:00.000Z',
    });
    const second = repo.insert({
      accountId: 'local-default',
      taskId: 'task_b',
      publicationId: 'publication_1',
      displayName: 'b.txt',
      relativePath: 'b.txt',
      publishedPath: '/tmp/b.txt',
      mediaType: 'text/plain; charset=utf-8',
      previewKind: 'text',
      contentHash: 'sha256:b1',
      byteLength: 2,
      now: '2026-08-24T01:01:00.000Z',
    });

    expect(repo.findByTaskAndRelativePath('task_a', 'a.md', 'sha256:a1')?.artifactId)
      .toBe(first.artifactId);
    expect(repo.findByTaskAndRelativePath('task_a', 'a.md', 'sha256:other')).toBeNull();

    repo.markUnavailable(first.artifactId, '2026-08-24T02:00:00.000Z');
    const unavailable = repo.findById(first.artifactId);
    expect(unavailable?.status).toBe('unavailable');
    expect(repo.toProjection(unavailable!).previewable).toBe(false);

    expect(repo.listByPublication('publication_1').map(item => item.taskId))
      .toEqual(['task_a', 'task_b']);
    expect(repo.listByTask('task_b').map(item => item.artifactId))
      .toEqual([second.artifactId]);
  });

  it('marks superseded same-path records unavailable while keeping the newest publishable', () => {
    const { repo } = createRepo();
    const old = repo.insert({
      accountId: 'local-default',
      taskId: 'task_a',
      displayName: 'r.md',
      relativePath: 'r.md',
      publishedPath: '/tmp/old-r.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown',
      contentHash: 'sha256:v1',
      byteLength: 2,
      now: '2026-08-24T01:00:00.000Z',
    });
    const otherFile = repo.insert({
      accountId: 'local-default',
      taskId: 'task_a',
      displayName: 'k.md',
      relativePath: 'k.md',
      publishedPath: '/tmp/k.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown',
      contentHash: 'sha256:k1',
      byteLength: 2,
      now: '2026-08-24T01:00:01.000Z',
    });
    const fresh = repo.insert({
      accountId: 'local-default',
      taskId: 'task_a',
      displayName: 'r.md',
      relativePath: 'r.md',
      publishedPath: '/tmp/new-r.md',
      mediaType: 'text/markdown; charset=utf-8',
      previewKind: 'markdown',
      contentHash: 'sha256:v2',
      byteLength: 3,
      now: '2026-08-24T01:00:02.000Z',
    });

    repo.markSupersededExcept('task_a', 'r.md', fresh.artifactId, '2026-08-24T01:00:03.000Z');

    expect(repo.findById(old.artifactId)?.status).toBe('unavailable');
    expect(repo.findById(fresh.artifactId)?.status).toBe('published');
    expect(repo.findById(otherFile.artifactId)?.status).toBe('published');
  });
});
