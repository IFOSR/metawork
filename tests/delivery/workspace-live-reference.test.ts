import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { UserArtifactPublicationService } from '../../src/delivery/user-artifact-publication-service.js';
import { ArtifactVersionRepo } from '../../src/storage/artifact-version-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';

let workspace: string;
const objectRoots: string[] = [];
let db: Database.Database;
let service: UserArtifactPublicationService;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'live-reference-'));
  await mkdir(join(workspace, 'out'), { recursive: true });
  await writeFile(join(workspace, 'out', 'deck.pptx'), 'pptx-v1');
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`
    INSERT INTO tasks (id, title, goal, status, summary, snapshot_json, resources_json,
      artifacts_json, dependencies_json, priority_json,
      last_scheduling_reason, last_interruption_reason, interruption_count,
      created_at, updated_at, account_id, conversation_id, workspace_id,
      owner_planner_session_id, admitted_at, execution_mode)
    VALUES ('task_1', 'Deck', 'goal', 'running', '', '[]', '[]', '[]', '[]', NULL,
      '', '', 0, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z',
      'local-default', 'conv_1', 'workspace_abc', 'conv_1', '2026-10-23T00:00:00.000Z', 'in_place')
  `).run();
  const objectRoot = join(workspace, '..', `${workspace.split('/').pop()}-objects`);
  service = new UserArtifactPublicationService({
    resolveUserWorkspaceRoot: async () => workspace,
    accountId: 'local-default',
    taskArtifactRepo: new TaskArtifactRepo(db),
    objectRoot,
    artifactVersionRepo: new ArtifactVersionRepo(db),
    now: () => '2026-10-23T00:00:00.000Z',
  });
  objectRoots.push(objectRoot);
});

afterEach(async () => {
  db.close();
  await rm(workspace, { recursive: true, force: true });
  for (const root of objectRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function rows(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM task_artifacts').all() as Array<Record<string, unknown>>;
}

describe('in-place live references', () => {
  it('registers the Workspace file without copying it anywhere', async () => {
    const result = await service.registerLiveWorkspaceReferences({
      sessionId: 'conv_1',
      accountId: 'local-default',
      taskId: 'task_1',
      taskTitle: 'Deck',
      workspaceId: 'workspace_abc',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      publicationId: 'publication_1',
      sources: [{ sourceRelativePath: 'out/deck.pptx' }],
    });

    expect(result.failures).toEqual([]);
    expect(result.taskDirectory).toBe(await realpath(workspace));
    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]?.relativePath).toBe('out/deck.pptx');

    const [record] = rows();
    expect(record.reference_kind).toBe('live_file');
    expect(record.workspace_id).toBe('workspace_abc');
    expect(record.source_relative_path).toBe('out/deck.pptx');
    expect(record.published_path).toBe(await realpath(join(workspace, 'out', 'deck.pptx')));
    // No delivery copy tree is created in the user Workspace.
    expect(await readdir(workspace)).not.toContain('metaclaw-tasks');
  });

  it('follows later edits instead of pinning stale bytes', async () => {
    const input = {
      sessionId: 'conv_1',
      accountId: 'local-default',
      taskId: 'task_1',
      taskTitle: 'Deck',
      workspaceId: 'workspace_abc',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      publicationId: 'publication_1',
      sources: [{ sourceRelativePath: 'out/deck.pptx' }],
    };
    await service.registerLiveWorkspaceReferences(input);
    await writeFile(join(workspace, 'out', 'deck.pptx'), 'pptx-v2-longer');
    await service.registerLiveWorkspaceReferences(input);

    const hashes = rows().map(row => row.content_hash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('records escapes, symlinks and missing files as failures instead of throwing', async () => {
    await symlink(join(workspace, 'out', 'deck.pptx'), join(workspace, 'out', 'link.pptx'));
    const result = await service.registerLiveWorkspaceReferences({
      sessionId: 'conv_1',
      accountId: 'local-default',
      taskId: 'task_1',
      taskTitle: 'Deck',
      workspaceId: 'workspace_abc',
      generationId: 'generation_1',
      subtaskId: 'subtask_1',
      publicationId: 'publication_1',
      sources: [
        { sourceRelativePath: '../escape.pptx' },
        { sourceRelativePath: 'out/link.pptx' },
        { sourceRelativePath: 'out/missing.pptx' },
      ],
    });
    expect(result.projections).toEqual([]);
    expect(result.failures.map(failure => failure.sourceRelativePath))
      .toEqual(['../escape.pptx', 'out/link.pptx', 'out/missing.pptx']);
    expect(result.failures.map(failure => failure.reason).join(' ')).toMatch(/unsafe|symbolic link|does not exist/u);
  });

  it('materializes fixed bytes for cross-Task handoffs', async () => {
    await service.registerLiveWorkspaceReferences({
      sessionId: 'conv_1', accountId: 'local-default', taskId: 'task_1', taskTitle: 'Deck',
      workspaceId: 'workspace_abc', generationId: 'generation_1', subtaskId: 'subtask_1',
      publicationId: 'publication_1', sources: [{ sourceRelativePath: 'out/deck.pptx' }],
    });
    // A declared handoff path must be pinnable: a vanished file fails the batch
    // instead of publishing a handoff that can only degrade later.
    await expect(service.materializeArtifactVersions({
      sessionId: 'conv_1', accountId: 'local-default', workspaceId: 'workspace_abc',
      taskId: 'task_1', attemptId: 'attempt_1', relativePaths: ['out/deck.pptx', 'out/missing.pptx'],
    })).rejects.toThrow(/disappeared before it could be pinned/u);

    const versions = await service.materializeArtifactVersions({
      sessionId: 'conv_1', accountId: 'local-default', workspaceId: 'workspace_abc',
      taskId: 'task_1', attemptId: 'attempt_1', relativePaths: ['out/deck.pptx'],
    });
    expect(versions).toHaveLength(1);
    const version = versions[0]!;
    expect(version.relativePath).toBe('out/deck.pptx');
    expect(version.objectUri).toBe(`sha256:${version.contentHash}`);
    const stored = await readFile(join(objectRoots[0]!, version.contentHash));
    expect(stored.toString()).toBe('pptx-v1');
    const row = db.prepare('SELECT reference_kind, artifact_version_id FROM task_artifacts').get() as
      { reference_kind: string; artifact_version_id: string };
    expect(row.reference_kind).toBe('artifact_version');
    expect(row.artifact_version_id).toBe(version.artifactVersionId);
  });

  it('skips fixed versions when no content store is configured', async () => {
    const plain = new UserArtifactPublicationService({
      resolveUserWorkspaceRoot: async () => workspace,
      accountId: 'local-default',
      taskArtifactRepo: new TaskArtifactRepo(db),
    });
    await expect(plain.materializeArtifactVersions({
      sessionId: 'conv_1', accountId: 'local-default', workspaceId: 'workspace_abc',
      taskId: 'task_1', attemptId: 'attempt_1', relativePaths: ['out/deck.pptx'],
    })).resolves.toEqual([]);
  });
});
