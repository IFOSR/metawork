import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactPreviewService } from '../../src/management/artifact-preview-service.js';
import type {
  ArtifactMetadataResult,
  ArtifactPreviewResult,
} from '../../src/management/artifact-preview-service.js';
import { USER_ARTIFACTS_DIRECTORY } from '../../src/delivery/user-artifact-types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface FixtureRecord {
  accountId: string;
  taskId: string;
  publicationId: string | null;
  displayName: string;
  relativePath: string;
  publishedPath: string;
  mediaType: string;
  previewKind: string;
  contentHash: string;
  byteLength: number;
  status: string;
  createdAt: string;
}

function recordFixture(overrides: Partial<FixtureRecord>): FixtureRecord {
  return {
    accountId: 'local-default',
    taskId: 'task_ab12cd34',
    publicationId: 'publication_1',
    displayName: 'report.md',
    relativePath: 'report.md',
    publishedPath: '/placeholder/report.md',
    mediaType: 'text/markdown; charset=utf-8',
    previewKind: 'markdown',
    contentHash: 'sha256:abc',
    byteLength: 10,
    status: 'published',
    createdAt: '2026-08-24T01:00:00.000Z',
    ...overrides,
  };
}

function createFixture(options: {
  extraRecords?: Record<string, FixtureRecord>;
  authorize?: (accountId: string, taskId: string) => boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'anyfusion-artifact-preview-'));
  roots.push(root);
  const userWorkspaceRoot = join(root, 'startup');
  const taskDirectory = join(userWorkspaceRoot, USER_ARTIFACTS_DIRECTORY, 'demo-task_ab12cd');
  mkdirSync(taskDirectory, { recursive: true });
  writeFileSync(join(taskDirectory, 'report.md'), '# Demo Report\n\n内容正文', 'utf8');

  const records: Record<string, FixtureRecord> = {
    artifact_demo: recordFixture({
      publishedPath: join(taskDirectory, 'report.md'),
      byteLength: Buffer.byteLength('# Demo Report\n\n内容正文'),
    }),
    ...options.extraRecords,
  };
  const service = new ArtifactPreviewService({
    taskArtifactSource: {
      findById: async artifactId => records[artifactId] ?? null,
    },
    query: {
      authorize: options.authorize ?? (() => true),
      currentAccountId: () => 'local-default',
    },
    userWorkspaceRoot,
  });
  return { root, userWorkspaceRoot, taskDirectory, service };
}

describe('ArtifactPreviewService', () => {
  it('returns the restricted projection without internal paths for metadata', async () => {
    const { service } = createFixture({});

    const result: ArtifactMetadataResult = await service.getMetadata('artifact_demo');

    expect(result).toMatchObject({
      ok: true,
      artifact: expect.objectContaining({
        artifactId: 'artifact_demo',
        taskId: 'task_ab12cd34',
        publicationId: 'publication_1',
        displayName: 'report.md',
        relativePath: 'report.md',
        previewKind: 'markdown',
        previewable: true,
      }),
    });
    // projection 绝不能携带内部绝对路径。
    expect(JSON.stringify(result)).not.toContain('publishedPath');
    expect(JSON.stringify(result)).not.toContain(USER_ARTIFACTS_DIRECTORY);
  });

  it('returns markdown content through the same-origin preview contract', async () => {
    const { service } = createFixture({});

    const result: ArtifactPreviewResult = await service.readPreview('artifact_demo');

    expect(result).toMatchObject({
      ok: true,
      content: '# Demo Report\n\n内容正文',
    });
  });

  it('rejects unknown ids as not_found', async () => {
    const { service } = createFixture({});
    await expect(service.readPreview('artifact_missing')).resolves
      .toEqual({ ok: false, reason: 'not_found' });
    await expect(service.getMetadata('../escape')).resolves
      .toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects artifacts owned by another account or unknown tasks as unauthorized', async () => {
    const { service } = createFixture({
      authorize: (_accountId, taskId) => taskId === 'task_other',
    });
    await expect(service.getMetadata('artifact_demo')).resolves
      .toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('marks missing published files unavailable instead of exposing paths', async () => {
    const { service } = createFixture({
      extraRecords: {
        artifact_gone: recordFixture({
          publicationId: null,
          displayName: 'gone.md',
          relativePath: 'gone.md',
          publishedPath: '/nonexistent/anywhere/gone.md',
          contentHash: 'sha256:gone',
        }),
      },
    });

    await expect(service.readPreview('artifact_gone')).resolves
      .toEqual({ ok: false, reason: 'unavailable' });
    await expect(service.resolveDownload('artifact_gone')).resolves
      .toEqual({ ok: false, reason: 'unavailable' });
  });

  it('refuses unsupported kinds while metadata stays available', async () => {
    const { taskDirectory, service } = createFixture({});
    const binaryPath = join(taskDirectory, 'assets', 'model.bin');
    mkdirSync(join(taskDirectory, 'assets'), { recursive: true });
    writeFileSync(binaryPath, Buffer.from([1, 2, 3]));

    const { service: binaryService } = createFixture({
      extraRecords: {
        artifact_binary: recordFixture({
          publicationId: null,
          displayName: 'model.bin',
          relativePath: 'assets/model.bin',
          publishedPath: binaryPath,
          mediaType: 'application/octet-stream',
          previewKind: 'unsupported',
          contentHash: 'sha256:bin',
          byteLength: 3,
        }),
      },
    });

    await expect(binaryService.readPreview('artifact_binary')).resolves
      .toEqual({ ok: false, reason: 'unsupported' });
    await expect(binaryService.getMetadata('artifact_binary')).resolves.toMatchObject({
      ok: true,
    });
    void service;
  });

  it('blocks symlinked and out-of-root published paths', async () => {
    const { root, taskDirectory } = createFixture({});
    const outsideFile = join(root, 'outside-secret.md');
    writeFileSync(outsideFile, 'secret');
    const linkedPath = join(taskDirectory, 'linked.md');
    symlinkSync(outsideFile, linkedPath);

    const linkedService = new ArtifactPreviewService({
      taskArtifactSource: {
        findById: async artifactId => artifactId === 'artifact_link'
          ? recordFixture({
            publicationId: null,
            publishedPath: linkedPath,
            relativePath: 'linked.md',
            contentHash: 'sha256:lnk',
          })
          : null,
      },
      query: { authorize: () => true, currentAccountId: () => 'local-default' },
      userWorkspaceRoot: join(root, 'startup'),
    });
    await expect(linkedService.readPreview('artifact_link')).resolves.toMatchObject({
      ok: false,
    });

    // 根外真实文件：即使记录存在也拒绝。
    const escapeService = new ArtifactPreviewService({
      taskArtifactSource: {
        findById: async artifactId => artifactId === 'artifact_escape'
          ? recordFixture({
            publicationId: null,
            displayName: 'outside.md',
            relativePath: '../outside-secret.md',
            publishedPath: outsideFile,
            contentHash: 'sha256:esc',
          })
          : null,
      },
      query: { authorize: () => true, currentAccountId: () => 'local-default' },
      userWorkspaceRoot: join(root, 'startup'),
    });
    await expect(escapeService.readPreview('artifact_escape')).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
  });
});
