import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import {
  UserArtifactPublicationService,
  userTaskDirectorySlug,
} from '../../src/delivery/user-artifact-publication-service.js';
import { USER_ARTIFACTS_DIRECTORY } from '../../src/delivery/user-artifact-types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createService(root: string, extraTaskIds: string[] = []): UserArtifactPublicationService {
  const startupWorkspaceRoot = join(root, 'startup');
  mkdirSync(startupWorkspaceRoot, { recursive: true });
  const db = new Database(':memory:');
  runMigrations(db);
  for (const taskId of ['seeded', ...extraTaskIds]) {
    db.prepare(`
      INSERT INTO tasks (id, title, goal, status, summary, snapshot_json, resources_json,
        dependencies_json, injected_prefs_json, created_at, updated_at)
      VALUES (?, ?, '', 'created', '', '[]', '[]', '[]', '[]',
        '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
    `).run(taskId, taskId);
  }
  return new UserArtifactPublicationService({
    userWorkspaceRoot: startupWorkspaceRoot,
    accountId: 'local-default',
    taskArtifactRepo: new TaskArtifactRepo(db),
  });
}

function seedIntegratedWorkspace(root: string): string {
  const workspaceRoot = join(root, 'integration');
  mkdirSync(join(workspaceRoot, 'reports', 'assets'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'report.md'), '# Report\n\nfinal');
  writeFileSync(join(workspaceRoot, 'summary.md'), '# Summary\n');
  writeFileSync(join(workspaceRoot, 'notes.txt'), 'plain text notes\n');
  writeFileSync(join(workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  symlinkSync(join(workspaceRoot, 'secret-outside.md'), join(workspaceRoot, 'linked.md'));
  return workspaceRoot;
}

describe('UserArtifactPublicationService', () => {
  it('publishes verified artifacts under the user workspace metaclaw-tasks directory with safe projections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-'));
    roots.push(root);
    const service = createService(root, ['task_ab12cd34']);
    const workspaceRoot = seedIntegratedWorkspace(root);

    const outcome = await service.publishIntegratedArtifacts({
      accountId: 'local-default',
      taskId: 'task_ab12cd34',
      taskTitle: '季度报告 Generation',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      publicationId: 'publication_1',
      integratedWorkspaceRoot: workspaceRoot,
      sources: [
        { sourceRelativePath: 'report.md' },
        { sourceRelativePath: 'notes.txt' },
        { sourceRelativePath: 'binary.bin' },
      ],
    });

    expect(outcome.failures).toEqual([]);
    expect(outcome.taskDirectory.startsWith(
      join(root, 'startup', USER_ARTIFACTS_DIRECTORY),
    )).toBe(true);
    expect(outcome.projections).toHaveLength(3);

    const report = outcome.projections[0];
    expect(report?.relativePath).toBe('report.md');
    expect(report?.previewKind).toBe('markdown');
    expect(report?.previewable).toBe(true);
    expect(report?.artifactId).toMatch(/^artifact_/u);
    expect(JSON.stringify(report)).not.toContain(workspaceRoot);
    expect(JSON.stringify(report)).not.toContain(outcome.taskDirectory);

    const publishedReport = join(outcome.taskDirectory, 'report.md');
    expect(readFileSync(publishedReport, 'utf8')).toBe('# Report\n\nfinal');

    const binary = outcome.projections.find(item => item.relativePath === 'binary.bin');
    expect(binary?.previewable).toBe(false);
    expect(binary?.previewKind).toBe('unsupported');

    const records = service.taskArtifactRepo.listByTask('task_ab12cd34');
    for (const record of records) {
      expect(record.publishedPath.startsWith(outcome.taskDirectory)).toBe(true);
    }
  });

  it('is idempotent for repeated publications of identical content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-idem-'));
    roots.push(root);
    const service = createService(root, ['task_repeat00']);
    const workspaceRoot = seedIntegratedWorkspace(root);
    const input = {
      accountId: 'local-default',
      taskId: 'task_repeat00',
      taskTitle: 'repeat',
      generationId: null,
      subtaskId: null,
      publicationId: 'p1',
      integratedWorkspaceRoot: workspaceRoot,
      sources: [{ sourceRelativePath: 'report.md' }],
    };

    const first = await service.publishIntegratedArtifacts(input);
    const second = await service.publishIntegratedArtifacts({ ...input, publicationId: 'p2' });

    expect(second.failures).toEqual([]);
    expect(second.projections[0]?.artifactId).toBe(first.projections[0]?.artifactId);
    expect(service.taskArtifactRepo.listByTask('task_repeat00')).toHaveLength(1);
  });

  it('marks the previous record unavailable when a same-name file is republished with new content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-name-'));
    roots.push(root);
    const service = createService(root, ['task_supersede']);
    const workspaceRoot = seedIntegratedWorkspace(root);
    const input = {
      accountId: 'local-default',
      taskId: 'task_supersede',
      taskTitle: 'supersede',
      generationId: null,
      subtaskId: null,
      publicationId: null,
      integratedWorkspaceRoot: workspaceRoot,
      sources: [{ sourceRelativePath: 'report.md' }],
    };

    await service.publishIntegratedArtifacts(input);
    writeFileSync(join(workspaceRoot, 'report.md'), '# Report v2\n');
    const second = await service.publishIntegratedArtifacts(input);

    expect(second.projections[0]?.contentHash).not.toContain('final');
    const projections = service.taskArtifactRepo
      .listByTask('task_supersede')
      .map(record => service.taskArtifactRepo.toProjection(record));
    const available = projections.filter(projection => projection.previewable);
    expect(available).toHaveLength(1);
    expect(existsSync(join(service.userWorkspaceRoot, USER_ARTIFACTS_DIRECTORY))).toBe(true);
  });

  it('rejects symbolic links and path traversal without blocking other artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-sec-'));
    roots.push(root);
    const service = createService(root, ['task_security']);
    const workspaceRoot = seedIntegratedWorkspace(root);

    const outcome = await service.publishIntegratedArtifacts({
      accountId: 'local-default',
      taskId: 'task_security',
      taskTitle: 'security',
      generationId: null,
      subtaskId: null,
      publicationId: null,
      integratedWorkspaceRoot: workspaceRoot,
      sources: [
        { sourceRelativePath: 'linked.md' },
        { sourceRelativePath: '../outside.md' },
        { sourceRelativePath: '/etc/hostname' },
        { sourceRelativePath: 'missing.md' },
        { sourceRelativePath: 'summary.md' },
      ],
    });

    expect(outcome.projections.map(projection => projection.relativePath))
      .toEqual(['summary.md']);
    expect(outcome.failures.map(failure => failure.sourceRelativePath).sort())
      .toEqual(['../outside.md', '/etc/hostname', 'linked.md', 'missing.md']);
    // 符号链接目标绝不能被复制到用户目录。
    expect(existsSync(join(outcome.taskDirectory, 'linked.md'))).toBe(false);
  });

  it('keeps the user task directory name stable from title slug and short task id', () => {
    const slug = userTaskDirectorySlug('Quarterly 报告!', 'task_xz9999ab');
    expect(slug).toBe('quarterly-报告-9999ab');
    expect(userTaskDirectorySlug('', 'task_xz9999ab')).toBe('task-9999ab');
  });

  it('records a failure when an artifact source disappears mid-publication without corrupting targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-corrupt-'));
    roots.push(root);
    const service = createService(root, ['task_corrupt0']);
    const workspaceRoot = join(root, 'late-failure');
    mkdirSync(join(workspaceRoot, 'keep'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'keep', 'fine.md'), '# fine');
    // 目录出现在文件位置：读取阶段失败，模拟损坏来源。
    mkdirSync(join(workspaceRoot, 'broken.md'), { recursive: true });

    const outcome = await service.publishIntegratedArtifacts({
      accountId: 'local-default',
      taskId: 'task_corrupt0',
      taskTitle: 'corrupt',
      generationId: null,
      subtaskId: null,
      publicationId: null,
      integratedWorkspaceRoot: workspaceRoot,
      sources: [
        { sourceRelativePath: 'broken.md' },
        { sourceRelativePath: join('keep', 'fine.md') },
      ],
    });

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.sourceRelativePath).toBe('broken.md');
    expect(outcome.projections).toHaveLength(1);
    expect(readFileSync(
      join(outcome.taskDirectory, 'keep', 'fine.md'),
      'utf8',
    )).toBe('# fine');
    expect(service.taskArtifactRepo.listByTask('task_corrupt0')).toHaveLength(1);
  });
});
