import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveArtifactContent, resolveArtifactContentSync } from '../../src/delivery/artifact-content-resolver.js';
import { ArtifactVersionRepo } from '../../src/storage/artifact-version-repo.js';
import type { TaskArtifactRecord } from '../../src/storage/task-artifact-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-version-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const objects = join(root, 'objects');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(objects, { recursive: true });
  return { root, workspace, objects };
}

function record(overrides: Partial<TaskArtifactRecord>): TaskArtifactRecord {
  return {
    artifactId: 'artifact_1',
    accountId: 'local-default',
    taskId: 'task_1',
    generationId: null,
    subtaskId: null,
    publicationId: null,
    displayName: 'report.md',
    relativePath: 'report.md',
    publishedPath: '/placeholder/report.md',
    mediaType: 'text/markdown',
    previewKind: 'markdown',
    contentHash: 'sha256:placeholder',
    byteLength: 0,
    status: 'published',
    referenceKind: 'live_file',
    workspaceId: 'workspace_1',
    artifactVersionId: null,
    sourceRelativePath: 'report.md',
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('artifact version consumption', () => {
  it('reads fixed bytes from the CAS even after the live file changed', async () => {
    const { workspace, objects } = fixture();
    writeFileSync(join(workspace, 'report.md'), 'version-one');
    const original = Buffer.from('version-one');
    const originalHash = createHash('sha256').update(original).digest('hex');
    writeFileSync(join(objects, originalHash), original);
    // The user edits the live file afterwards.
    writeFileSync(join(workspace, 'report.md'), 'version-two');

    const content = await resolveArtifactContent({
      artifact: record({
        referenceKind: 'artifact_version',
        artifactVersionId: 'version_1',
        contentHash: `sha256:${originalHash}`,
      }),
      artifactVersion: {
        artifactVersionId: 'version_1',
        accountId: 'local-default',
        workspaceId: 'workspace_1',
        sourceTaskId: 'task_1',
        sourceAttemptId: 'attempt_1',
        relativePath: 'report.md',
        contentHash: originalHash,
        byteLength: original.length,
        objectUri: `sha256:${originalHash}`,
        mediaType: 'text/markdown',
        createdAt: '2026-10-24T00:00:00.000Z',
      },
      objectRoot: objects,
      workspaceRoot: workspace,
    });

    expect(content.immutable).toBe(true);
    expect(content.bytes.toString('utf8')).toBe('version-one');
    expect(content.contentHash).toBe(`sha256:${originalHash}`);
  });

  it('reports a live reference as the current bytes with their observed hash', async () => {
    const { workspace } = fixture();
    writeFileSync(join(workspace, 'report.md'), 'current content');

    const content = await resolveArtifactContent({
      artifact: record({ contentHash: 'sha256:stale-recorded-hash' }),
      workspaceRoot: workspace,
    });

    expect(content.immutable).toBe(false);
    expect(content.bytes.toString('utf8')).toBe('current content');
    expect(content.contentHash).toBe(
      `sha256:${createHash('sha256').update(Buffer.from('current content')).digest('hex')}`,
    );
  });

  it('refuses a fixed version whose object is missing instead of falling back', async () => {
    const { workspace, objects } = fixture();
    writeFileSync(join(workspace, 'report.md'), 'current');
    await expect(resolveArtifactContent({
      artifact: record({ referenceKind: 'artifact_version', artifactVersionId: 'missing' }),
      artifactVersion: null,
      objectRoot: objects,
      workspaceRoot: workspace,
    })).rejects.toThrow(/artifact version is not registered/u);
  });

  it('resolves the content-addressed object synchronously for context preparation', () => {
    const { workspace, objects } = fixture();
    writeFileSync(join(workspace, 'report.md'), 'pinned');
    const hash = createHash('sha256').update(Buffer.from('pinned')).digest('hex');
    writeFileSync(join(objects, hash), Buffer.from('pinned'));
    const content = resolveArtifactContentSync({
      artifact: record({ referenceKind: 'artifact_version', artifactVersionId: 'version_1' }),
      artifactVersion: {
        artifactVersionId: 'version_1',
        accountId: 'local-default',
        workspaceId: 'workspace_1',
        sourceTaskId: 'task_1',
        sourceAttemptId: 'attempt_1',
        relativePath: 'report.md',
        contentHash: hash,
        byteLength: 6,
        objectUri: `sha256:${hash}`,
        mediaType: 'text/markdown',
        createdAt: '2026-10-24T00:00:00.000Z',
      },
      objectRoot: objects,
      workspaceRoot: workspace,
    });
    expect(content.bytes.toString('utf8')).toBe('pinned');
    expect(content.immutable).toBe(true);
  });

  it('registers versions idempotently per workspace, path and hash', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const repo = new ArtifactVersionRepo(db);
    const input = {
      accountId: 'local-default',
      workspaceId: 'workspace_1',
      sourceTaskId: 'task_1',
      sourceAttemptId: 'attempt_1',
      relativePath: 'out/report.md',
      contentHash: 'abc123',
      byteLength: 10,
      objectUri: 'sha256:abc123',
      mediaType: 'text/markdown',
    };
    const first = repo.record(input);
    const second = repo.record(input);
    expect(second.artifactVersionId).toBe(first.artifactVersionId);
    expect(repo.find(first.artifactVersionId)?.contentHash).toBe('abc123');
    db.close();
  });
});
