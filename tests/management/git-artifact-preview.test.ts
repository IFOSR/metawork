import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPreviewService } from '../../src/management/artifact-preview-service.js';
import { workspaceGitRepositoryPath } from '../../src/execution/workspace-git-service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mw-git-preview-'));
  roots.push(root);
  const working = join(root, 'working');
  mkdirSync(working);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: working, encoding: 'utf8' }).trim();
  git('init', '-q');
  const content = '# 固定版本\n状态：发布成功\n';
  writeFileSync(join(working, 'report.md'), content);
  git('add', 'report.md'); git('commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const repository = workspaceGitRepositoryPath(root, 'workspace');
  mkdirSync(dirname(repository), { recursive: true });
  git('clone', '-q', '--bare', working, repository);
  execFileSync('git', ['--git-dir', repository, 'update-ref', 'refs/metawork/artifacts/version', commit]);
  const version = { artifactVersionId: 'version', accountId: 'local-default', workspaceId: 'workspace', sourceTaskId: 'task',
    sourceAttemptId: 'attempt', relativePath: 'report.md', contentHash: createHash('sha256').update(content).digest('hex'),
    byteLength: Buffer.byteLength(content), objectUri: `git-object:workspace:${commit}:report.md`, gitCommit: commit,
    gitRelativePath: 'report.md', mediaType: 'text/markdown', createdAt: 'now' };
  const record = { accountId: 'local-default', taskId: 'task', publicationId: null, displayName: 'report.md', relativePath: 'report.md',
    publishedPath: join(working, 'report.md'), mediaType: 'text/markdown', previewKind: 'markdown', contentHash: version.contentHash,
    byteLength: version.byteLength, status: 'published', createdAt: 'now', referenceKind: 'artifact_version' as const,
    workspaceId: 'workspace', artifactVersionId: 'version', sourceRelativePath: 'report.md' };
  const service = new ArtifactPreviewService({ taskArtifactSource: { findById: () => record },
    query: { authorize: () => true, currentAccountId: () => 'local-default' },
    artifactVersionRepo: { find: () => version } as never,
    objectRoot: join(root, 'workspace-store', 'objects', 'sha256', 'artifacts') });
  // A newer live file must never substitute for the pinned version.
  writeFileSync(join(working, 'report.md'), 'newer unverified bytes');
  return { service, content, version, repository };
}

describe('pinned Git artifact HTTP source', () => {
  it('serves metadata, preview and exact download bytes without a loose CAS file', async () => {
    const f = fixture();
    expect(await f.service.getMetadata('artifact')).toMatchObject({ ok: true });
    expect(await f.service.readPreview('artifact')).toMatchObject({ ok: true, content: f.content });
    expect(await f.service.resolveDownload('artifact')).toMatchObject({ ok: true, content: Buffer.from(f.content), absolutePath: null });
  });

  it.each(['foreign-workspace', 'digest-mismatch', 'missing-pin'] as const)('refuses %s for both preview and download', async mode => {
    const f = fixture();
    if (mode === 'foreign-workspace') f.version.workspaceId = 'other';
    if (mode === 'digest-mismatch') f.version.contentHash = '0'.repeat(64);
    if (mode === 'missing-pin') execFileSync('git', ['--git-dir', f.repository, 'update-ref', '-d', 'refs/metawork/artifacts/version']);
    expect(await f.service.readPreview('artifact')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await f.service.resolveDownload('artifact')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
