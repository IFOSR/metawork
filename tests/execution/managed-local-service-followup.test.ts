import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedLocalServices } from '../../src/execution/managed-local-service.js';
import { localServiceSpecificationRevision } from '../../src/core/local-service-revision.js';
import { ManagedLocalServiceRepo } from '../../src/storage/managed-local-service-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OLD_MANIFEST = {
  serviceId: 'fireworks-canvas-demo',
  command: 'node',
  args: ['server.js'],
  host: '127.0.0.1',
  port: 4173,
  healthPath: '/health',
  startupTimeoutMs: 1_000,
  restartPolicy: 'explicit',
  environmentReferences: {},
};

/**
 * A Workspace that already holds an old service and a newly delivered project.
 * This is the reported shape: the old `.metawork-service.json` sits at the
 * Workspace root and must not become the launch contract of the new site.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-followup-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'fireworks-canvas-demo'), { recursive: true });
  await writeFile(join(workspace, 'fireworks-canvas-demo', 'server.js'), 'setInterval(() => {}, 1_000);\n');
  await writeFile(join(workspace, '.metawork-service.json'), JSON.stringify(OLD_MANIFEST));
  await mkdir(join(workspace, 'deliverables', 'ai-radar-site'), { recursive: true });
  await writeFile(join(workspace, 'deliverables', 'ai-radar-site', 'server.js'), `import http from 'node:http';
http.createServer((request, response) => { response.end('ok'); })
  .listen(Number(process.env.PORT), process.env.HOST);`);

  const db = new Database(join(root, 'state.db'));
  runMigrations(db);
  cleanups.push(async () => db.close());
  const insertTask = db.prepare(
    "INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES (?, ?, ?, 'succeeded', 'now', 'now')",
  );
  insertTask.run('task_old', 'Fireworks', 'Build fireworks');
  insertTask.run('task_new', 'AI radar', 'Build the AI radar site');

  const artifacts = new Map<string, string[]>([
    ['task_old', []],
    ['task_new', ['deliverables/ai-radar-site/server.js']],
  ]);
  const targetPaths = new Map<string, string[]>([
    ['task_new', ['deliverables/ai-radar-site']],
  ]);
  const manager = new ManagedLocalServices({
    accountId: 'local-default',
    store: new ManagedLocalServiceRepo(db, 'local-default'),
    logRoot: join(root, 'managed-services'),
    resolvePublishedDirectory: async () => workspace,
    resolveWorkspaceId: async () => 'workspace_1',
    resolveEnvironment: async () => null,
    isPublishedServiceSpecification: async (taskId, _root, relativePath) => {
      if ((artifacts.get(taskId) ?? []).includes(relativePath)) return true;
      return (targetPaths.get(taskId) ?? []).some(target => {
        const normalized = target.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '');
        return normalized === '' || relativePath === normalized || relativePath.startsWith(`${normalized}/`);
      });
    },
    listTaskArtifactPaths: async taskId => artifacts.get(taskId) ?? [],
    listTaskTargetPaths: async taskId => targetPaths.get(taskId) ?? [],
  });
  cleanups.push(async () => {
    for (const serviceId of ['ai-radar-site', 'local-service']) {
      await manager.stop(serviceId).catch(() => undefined);
    }
  });
  return { manager, workspace, artifacts, targetPaths, db };
}

describe('follow-up run target resolution', () => {
  it('targets the newly delivered project and ignores the Workspace-root service file', async () => {
    const { manager } = await fixture();
    const resolved = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(resolved.targetPath).toBe('deliverables/ai-radar-site');
    expect(resolved.source).toBe('discovered');
    expect(resolved.specification.serviceId).toBe('ai-radar-site');
    expect(resolved.specification.directory).toBe('deliverables/ai-radar-site');
    expect(resolved.specification.origin).toBe('discovered');
    // No health check was declared: the contract must not invent one.
    expect(resolved.specification.healthPath).toBeNull();
    expect(resolved.evidence.join('；')).toContain('已忽略 Workspace 根目录的服务规格');
    // The old project's command/port must not leak into the new target.
    expect(resolved.specification.port).not.toBe(OLD_MANIFEST.port);
    expect(resolved.specification.serviceId).not.toBe(OLD_MANIFEST.serviceId);
  });

  it('starts a discovered project with no service file and records a real handle', async () => {
    const { manager } = await fixture();
    const { specification } = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    const effect = await manager.applyAuthorizedOperation({
      decisionId: 'decision-follow-up-start',
      operation: 'start',
      serviceId: specification.serviceId,
      specification,
      workspaceId: 'workspace_1',
      specificationRevision: localServiceSpecificationRevision(specification),
    });
    expect(effect.error).toBeNull();
    expect(effect.result?.state).toBe('running');
    expect(effect.result?.url).toBe('');
    expect(effect.result?.message).toContain('未声明健康检查');
    const record = manager.find(specification.serviceId);
    expect(record?.processId).toBeGreaterThan(0);
    expect(record?.processToken).toBeTruthy();
    // The recorded contract, not a fresh guess, owns the next operation.
    const replay = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(replay.source).toBe('registered');
    expect(replay.specification).toEqual(specification);
    const firstToken = record?.processToken;
    await manager.stop(specification.serviceId);
    expect(manager.find(specification.serviceId)?.state).toBe('stopped');
    // Restart reuses the recorded contract: the same revision, a new process.
    const restarted = await manager.restart(specification.serviceId);
    expect(restarted.state).toBe('running');
    const restartedRecord = manager.find(specification.serviceId);
    expect(restartedRecord?.processToken).not.toBe(firstToken);
    expect(restartedRecord?.specificationRevision)
      .toBe(localServiceSpecificationRevision(specification));
    // Recovery observes the owned process instead of launching another one.
    await manager.recover();
    expect((await manager.status(specification.serviceId)).state).toBe('running');
    expect(manager.find(specification.serviceId)?.processId).toBe(restartedRecord?.processId);
  }, 20_000);

  it('uses the Task target path when an in-place edit has no downloadable artifact rows', async () => {
    const { manager, artifacts } = await fixture();
    artifacts.set('task_new', []);
    const resolved = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(resolved.targetPath).toBe('deliverables/ai-radar-site');
    expect(resolved.source).toBe('discovered');
    expect(resolved.specification.command).toBe('node');
    expect(resolved.specification.args).toEqual(['server.js']);
  });

  it('resolves a declared root-level target file to the Workspace project root', async () => {
    const { manager, workspace, artifacts, targetPaths } = await fixture();
    await writeFile(join(workspace, 'server.js'), 'setInterval(() => {}, 1_000);\n');
    artifacts.set('task_new', []);
    targetPaths.set('task_new', ['server.js']);
    const resolved = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(resolved.targetPath).toBe('');
    expect(resolved.specification.directory).toBe('');
    expect(resolved.specification.serviceId).toBe('local-service');
  });

  it('rebinds a registered project contract to a later Task in the same Workspace', async () => {
    const { manager, db, targetPaths, artifacts } = await fixture();
    const { specification } = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    const started = await manager.applyAuthorizedOperation({
      decisionId: 'decision-first-owner', operation: 'start', serviceId: specification.serviceId,
      specification, workspaceId: 'workspace_1',
      specificationRevision: localServiceSpecificationRevision(specification),
    });
    expect(started.error).toBeNull();
    db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES (?, ?, ?, 'succeeded', 'now', 'now')")
      .run('task_followup', 'AI radar follow-up', 'Start the delivered site');
    targetPaths.set('task_followup', ['deliverables/ai-radar-site']);
    artifacts.set('task_followup', []);

    const followup = await manager.resolveServiceSpecification({ taskId: 'task_followup' });
    expect(followup.source).toBe('registered');
    expect(followup.specification.taskId).toBe('task_followup');
    expect(localServiceSpecificationRevision(followup.specification))
      .toBe(localServiceSpecificationRevision(specification));
    const result = await manager.applyAuthorizedOperation({
      decisionId: 'decision-followup-owner', operation: 'start', serviceId: followup.specification.serviceId,
      specification: followup.specification, workspaceId: 'workspace_1',
      specificationRevision: localServiceSpecificationRevision(followup.specification),
    });
    expect(result.error).toBeNull();
    expect(manager.findForWorkspace('workspace_1', specification.serviceId)?.specification.taskId)
      .toBe('task_followup');
  }, 20_000);

  it('uses a service specification delivered inside the target project', async () => {
    const { manager, workspace } = await fixture();
    const targetManifest = {
      serviceId: 'ai-radar-site',
      command: 'node',
      args: ['server.js'],
      host: '127.0.0.1',
      port: 4399,
      healthPath: '/health',
      startupTimeoutMs: 1_000,
      restartPolicy: 'explicit',
      environmentReferences: {},
    };
    await writeFile(
      join(workspace, 'deliverables', 'ai-radar-site', '.metawork-service.json'),
      JSON.stringify(targetManifest),
    );
    const resolved = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(resolved.source).toBe('manifest');
    expect(resolved.specification).toMatchObject({
      serviceId: 'ai-radar-site',
      port: 4399,
      healthPath: '/health',
      origin: 'manifest',
    });
    const started = await manager.applyAuthorizedOperation({
      decisionId: 'decision-target-local-manifest', operation: 'start',
      serviceId: resolved.specification.serviceId, specification: resolved.specification,
      workspaceId: 'workspace_1',
      specificationRevision: localServiceSpecificationRevision(resolved.specification),
    });
    expect(started.error).toBeNull();
    expect(started.result?.state).toBe('healthy');
  });

  it('reports a broken project manifest and still finds the launch from the project', async () => {
    const { manager, workspace } = await fixture();
    await writeFile(
      join(workspace, 'deliverables', 'ai-radar-site', '.metawork-service.json'),
      '{ broken json',
    );
    const resolved = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(resolved.source).toBe('discovered');
    expect(resolved.specification.command).toBe('node');
    expect(resolved.evidence.join('；')).toContain('目标项目的服务规格不可用');
  });

  it('ignores a target-local manifest owned by another Task and discovers the current project', async () => {
    const { manager, workspace } = await fixture();
    await writeFile(join(workspace, 'deliverables', 'ai-radar-site', '.metawork-service.json'), JSON.stringify({
      ...OLD_MANIFEST,
      taskId: 'task_old',
    }));
    const resolved = await manager.resolveServiceSpecification({ taskId: 'task_new' });
    expect(resolved.targetPath).toBe('deliverables/ai-radar-site');
    expect(resolved.source).toBe('discovered');
    expect(resolved.specification.command).toBe('node');
    expect(resolved.evidence.join('；')).toContain('已改为检查项目本身');
  });

  it('asks for a decision when two delivered projects are plausible targets', async () => {
    const { manager, artifacts } = await fixture();
    artifacts.set('task_new', ['apps/a/server.js', 'apps/b/server.js']);
    await expect(manager.resolveServiceSpecification({ taskId: 'task_new' }))
      .rejects.toThrow('运行目标不唯一');
  });
});
