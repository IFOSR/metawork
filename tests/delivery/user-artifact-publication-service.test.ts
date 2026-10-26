import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, chmodSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
        dependencies_json, injected_prefs_json, created_at, updated_at) VALUES (?, ?, '', 'queued', '', '[]', '[]', '[]', '[]', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
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
  it('publishes code without inventing downloadable artifacts, and retires stale downloads on later code edits or deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metawork-code-artifacts-')); roots.push(root);
    const service = createService(root, ['code-task']);
    const source = seedIntegratedWorkspace(root);
    const input = { accountId: 'local-default', taskId: 'code-task', taskTitle: 'Code', generationId: 'g',
      subtaskId: 's', publicationId: 'p1', integratedWorkspaceRoot: source,
      sources: [{ sourceRelativePath: 'report.md', downloadable: false }] };
    const first = await service.publishIntegratedArtifacts(input);
    expect(first.failures).toEqual([]); expect(first.projections).toEqual([]);
    expect(service.taskArtifactRepo.listByTask('code-task')).toEqual([]);
    expect(service.taskArtifactRepo.publicFiles.list('local-default', 'code-task')).toHaveLength(1);
    expect(service.taskArtifactRepo.publicFiles.list('another', 'code-task')).toEqual([]);
    await service.publishIntegratedArtifacts({ ...input, sources: [{ sourceRelativePath: 'report.md' }] });
    expect(service.taskArtifactRepo.listByTask('code-task')[0]!.status).toBe('published');
    writeFileSync(join(source, 'report.md'), 'updated code without a download declaration');
    expect((await service.publishIntegratedArtifacts({ ...input, publicationId: 'p2' })).failures).toEqual([]);
    expect(readFileSync(join(first.taskDirectory, 'report.md'), 'utf8')).toBe('updated code without a download declaration');
    expect(service.taskArtifactRepo.listByTask('code-task')[0]!.status).toBe('unavailable');
    expect((await service.publishIntegratedArtifacts({ ...input, publicationId: 'p3',
      sources: [{ sourceRelativePath: 'report.md', remove: true }] })).failures).toEqual([]);
    expect(existsSync(join(first.taskDirectory, 'report.md'))).toBe(false);
    expect(service.taskArtifactRepo.publicFiles.list('local-default', 'code-task')).toEqual([]);
  });
  it('publishes verified artifacts at the Workspace-relative declared paths with safe projections', async () => {
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
    // Without an explicitly selected project directory the authorized change
    // set is applied at the Workspace root; no generated task directory.
    expect(outcome.taskDirectory).toBe(realpathSync(join(root, 'startup')));
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

  it('adopts the verified file after interruption between rename and artifact row insertion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-interrupted-'));
    roots.push(root);
    const service = createService(root);
    const input = { accountId: 'local-default', taskId: 'seeded', taskTitle: 'interrupted', generationId: null,
      subtaskId: null, publicationId: 'publication', integratedWorkspaceRoot: seedIntegratedWorkspace(root),
      sources: [{ sourceRelativePath: 'report.md' }] };
    const insert = vi.spyOn(service.taskArtifactRepo, 'insert').mockImplementationOnce(() => {
      throw new Error('interrupted before artifact row');
    });
    const failed = await service.publishIntegratedArtifacts(input);
    expect(failed.failures).toHaveLength(1);
    expect(service.taskArtifactRepo.listByTask('seeded')).toHaveLength(0);
    const target = join(failed.taskDirectory, 'report.md');
    expect(readFileSync(target, 'utf8')).toBe('# Report\n\nfinal');
    utimesSync(target, 1, 1);
    const before = statSync(target);
    insert.mockRestore();
    const recovered = new UserArtifactPublicationService({ userWorkspaceRoot: service.userWorkspaceRoot,
      taskArtifactRepo: service.taskArtifactRepo });
    const outcome = await recovered.publishIntegratedArtifacts(input);
    expect(outcome.failures).toEqual([]);
    expect(statSync(target)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(service.taskArtifactRepo.listByTask('seeded')).toHaveLength(1);
    expect((await recovered.publishIntegratedArtifacts(input)).projections[0]?.artifactId)
      .toBe(outcome.projections[0]?.artifactId);
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
    expect(service.taskArtifactRepo.publicFiles.list('local-default', 'task_supersede')
      .map(record => record.relativePath)).toContain('report.md');
  });

  it('reactivates a previously superseded artifact when the same content is published again', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-user-artifacts-reactivate-'));
    roots.push(root);
    const service = createService(root, ['task_reactivate']);
    const workspaceRoot = seedIntegratedWorkspace(root);
    const input = {
      accountId: 'local-default',
      taskId: 'task_reactivate',
      taskTitle: 'reactivate',
      generationId: null,
      subtaskId: null,
      publicationId: null,
      integratedWorkspaceRoot: workspaceRoot,
      sources: [{ sourceRelativePath: 'report.md' }],
    };

    const first = await service.publishIntegratedArtifacts(input);
    writeFileSync(join(workspaceRoot, 'report.md'), '# Report v2\n');
    await service.publishIntegratedArtifacts(input);
    writeFileSync(join(workspaceRoot, 'report.md'), '# Report\n\nfinal');
    const third = await service.publishIntegratedArtifacts(input);

    expect(third.projections[0]?.artifactId).toBe(first.projections[0]?.artifactId);
    expect(service.taskArtifactRepo.listByTask('task_reactivate'))
      .toHaveLength(2);
    expect(service.taskArtifactRepo.findById(first.projections[0]!.artifactId)?.status)
      .toBe('published');
  });

  it('rejects the entire publication before writing when any source escapes or is invalid', async () => {
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
      .toEqual([]);
    expect(outcome.failures.map(failure => failure.sourceRelativePath).sort())
      .toEqual(['../outside.md', '/etc/hostname', 'linked.md', 'missing.md']);
    // 符号链接目标绝不能被复制到用户目录。
    expect(existsSync(join(outcome.taskDirectory, 'linked.md'))).toBe(false);
  });

  it('keeps the user task directory name stable from title slug and short task id', () => {
    const slug = userTaskDirectorySlug('Quarterly 报告!', 'task_xz9999ab');
    expect(slug).toMatch(/^quarterly-报告-[a-f0-9]{16}$/u);
    expect(userTaskDirectorySlug('', 'task_xz9999ab')).toMatch(/^task-[a-f0-9]{16}$/u);
    expect(userTaskDirectorySlug('same', 'prefix_9999ab')).not.toBe(userTaskDirectorySlug('same', 'other_9999ab'));
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
    expect(outcome.projections).toHaveLength(0);
    expect(existsSync(join(outcome.taskDirectory, 'keep', 'fine.md'))).toBe(false);
    expect(service.taskArtifactRepo.listByTask('task_corrupt0')).toHaveLength(0);
    rmSync(join(workspaceRoot, 'broken.md'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'broken.md'), '# repaired');
    const restarted = new UserArtifactPublicationService({ userWorkspaceRoot: join(root, 'startup'), taskArtifactRepo: service.taskArtifactRepo });
    const retry = await restarted.publishIntegratedArtifacts({ accountId: 'local-default', taskId: 'task_corrupt0',
      taskTitle: 'corrupt', generationId: null, subtaskId: null, publicationId: null,
      integratedWorkspaceRoot: workspaceRoot, sources: [{ sourceRelativePath: 'broken.md' }, { sourceRelativePath: 'keep/fine.md' }] });
    expect(retry.failures).toEqual([]);
    expect(retry.projections).toHaveLength(2);
    expect(readFileSync(join(retry.taskDirectory, 'keep/fine.md'), 'utf8')).toBe('# fine');
    expect(service.taskArtifactRepo.listByTask('task_corrupt0')).toHaveLength(2);

  });
});


describe('public Workspace delivery safety', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'metawork-public-test-')); roots.push(root);
    const service = createService(root); const origin = seedIntegratedWorkspace(root);
    const input = { accountId: 'local-default', taskId: 'seeded', taskTitle: 'public', generationId: null,
      subtaskId: null, publicationId: null, integratedWorkspaceRoot: origin, sources: [{ sourceRelativePath: 'report.md' }] };
    return { service, input, origin };
  }
  it('updates real files and HEAD in an initially empty Git Workspace', async () => {
    const { service, input } = setup();
    execFileSync('git', ['init', service.userWorkspaceRoot]);
    const result = await service.publishIntegratedArtifacts(input);
    expect(result.failures).toEqual([]);
    expect(readFileSync(join(result.taskDirectory, 'report.md'), 'utf8')).toContain('final');
    const head = execFileSync('git', ['-C', service.userWorkspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    expect((await service.publishIntegratedArtifacts(input)).failures).toEqual([]);
    expect(execFileSync('git', ['-C', service.userWorkspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).toBe(head);
    expect(execFileSync('git', ['-C', service.userWorkspaceRoot, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });
  it('fails closed on a damaged Git repository', async () => {
    const { service, input } = setup();
    writeFileSync(join(service.userWorkspaceRoot, '.git'), 'gitdir: /does/not/exist');
    const result = await service.publishIntegratedArtifacts(input);
    expect(result.failures[0]?.reason).toContain('Git Workspace 无效');
    // The delivery root is the existing Workspace itself; nothing new may appear.
    expect(existsSync(join(result.taskDirectory, 'report.md'))).toBe(false);
    expect(service.taskArtifactRepo.publicFiles.list('local-default', 'seeded')).toEqual([]);
  });
  it('serializes two publisher instances and preserves the externally deleted file conflict', async () => {
    const { service, input, origin } = setup();
    const other = new UserArtifactPublicationService({ userWorkspaceRoot: service.userWorkspaceRoot, taskArtifactRepo: service.taskArtifactRepo });
    const [first, second] = await Promise.all([service.publishIntegratedArtifacts(input), other.publishIntegratedArtifacts(input)]);
    expect(first.failures).toEqual([]); expect(second.failures).toEqual([]);
    expect(service.taskArtifactRepo.listByTask('seeded')).toHaveLength(1);
    rmSync(join(first.taskDirectory, 'report.md'));
    writeFileSync(join(origin, 'report.md'), 'updated');
    const failed = await other.publishIntegratedArtifacts(input);
    expect(failed.failures[0]?.reason).toContain('文件已被删除');
    expect(existsSync(join(first.taskDirectory, 'report.md'))).toBe(false);
  });
  it('rejects internal path references in deliverable bytes before any file becomes public', async () => {
    const { service, input, origin } = setup();
    writeFileSync(join(origin, 'report.md'), 'Code is at /Users/example/.metawork/accounts/local-default/workspace-store/workspaces/worktree/server');
    const result = await service.publishIntegratedArtifacts(input);
    expect(result.failures[0]?.reason).toContain('内部执行路径');
    expect(existsSync(join(result.taskDirectory, 'report.md'))).toBe(false);
  });
});
