import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { ManagedLocalServices, validateLocalServiceSpecification, type LocalServiceSpecification } from '../../src/execution/managed-local-service.js';
import { localServiceSpecificationRevision } from '../../src/core/local-service-revision.js';
import { ManagedLocalServiceRepo } from '../../src/storage/managed-local-service-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(health = '/health') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'metawork-service-')));
  const published = join(root, 'user-workspace', 'metaclaw-tasks', 'backend');
  await mkdir(published, { recursive: true });
  const db = new Database(join(root, 'state.db'));
  runMigrations(db);
  db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('task', 'Service', 'Service', 'succeeded', 'now', 'now')").run();
  const port = await new Promise<number>(accept => {
    const probe = createServer(); probe.listen(0, '127.0.0.1', () => {
      const address = probe.address(); const value = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => accept(value));
    });
  });
  await writeFile(join(published, 'server.mjs'), `import http from 'node:http';
console.log('service cwd=' + process.cwd());
http.createServer((req,res) => { res.statusCode=req.url==='/health'?200:503;res.end('ready'); }).listen(process.env.PORT,process.env.HOST);`);
  const spec: LocalServiceSpecification = { serviceId: 'backend', taskId: 'task', command: process.execPath,
    args: ['server.mjs'], environmentReferences: {}, host: '127.0.0.1', port, healthPath: health,
    startupTimeoutMs: 2000, restartPolicy: 'explicit' };
  await writeFile(join(published, '.metawork-service.json'), JSON.stringify(spec));
  const deps = { accountId: 'local-default', store: new ManagedLocalServiceRepo(db, 'local-default'),
    logRoot: join(root, 'private', 'managed-services'), resolvePublishedDirectory: async () => published,
    resolveEnvironment: async () => null };
  const manager = new ManagedLocalServices(deps);
  cleanups.push(async () => { await manager.stop('backend').catch(() => undefined); db.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, spec, deps, published, root };
}

describe('managed local service user scenarios', () => {
  it('binds a manifest without Task identity and rejects an explicit foreign Task', async () => {
    const { manager, spec, published } = await fixture();
    const { taskId: _taskId, ...manifest } = spec;
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(manifest));
    expect(await manager.readSpecification('task')).toEqual(spec);
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify({ ...manifest, taskId: 'foreign' }));
    await expect(manager.readSpecification('task')).rejects.toThrow('服务规格不属于当前任务');
  });

  it('distinguishes published code from a missing service specification', async () => {
    const { manager, spec, published, deps } = await fixture();
    await rm(join(published, '.metawork-service.json'));

    await expect(manager.readSpecification('task')).rejects.toThrow(
      '代码已发布，但任务目录中没有可启动的服务规格（.metawork-service.json）',
    );
    await expect(manager.start(spec)).rejects.toThrow(
      '代码已发布，但任务目录中没有可启动的服务规格（.metawork-service.json）',
    );

    const unpublished = new ManagedLocalServices({ ...deps, resolvePublishedDirectory: async () => null });
    await expect(unpublished.readSpecification('task')).rejects.toThrow('代码尚未发布到用户任务目录');

    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(spec));
    const unrecorded = new ManagedLocalServices({ ...deps,
      isPublishedServiceSpecification: async () => false });
    await expect(unrecorded.readSpecification('task')).rejects.toThrow(
      '代码已发布，但任务目录中没有可启动的服务规格（.metawork-service.json）',
    );
  });

  it('allows only an explicit update read to inspect a changed manifest revision', async () => {
    const { manager, spec, published } = await fixture();
    await manager.start(spec);
    const changed = { ...spec, args: ['changed-server.mjs'] };
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(changed));
    await expect(manager.readSpecification('task')).rejects.toThrow('需要显式的服务更新授权');
    await expect(manager.readSpecification('task', { allowRevisionChange: true })).resolves.toEqual(changed);
    await manager.stop(spec.serviceId);
  }, 10000);

  it('cleans up a background grandchild when the service command exits unexpectedly', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'child.mjs'), `import http from 'node:http';process.on('SIGTERM',()=>{});
http.createServer((req,res)=>res.end('child alive')).listen(process.env.PORT,process.env.HOST);`);
    await writeFile(join(published, 'server.mjs'), `import {spawn} from 'node:child_process';
spawn(process.execPath,['child.mjs'],{stdio:'inherit'});setTimeout(()=>process.exit(1),1500);`);
    const started = await manager.start(spec);
    expect(started.state).toBe('healthy');
    await expect.poll(async () => (await manager.status(spec.serviceId)).state, { timeout: 4000 }).toBe('failed');
    await expect(fetch(started.url + '/health')).rejects.toThrow();
  }, 10000);

  it('stops grandchildren that ignore TERM after the original service process exits', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'child.mjs'), `import http from 'node:http';process.on('SIGTERM',()=>{});
http.createServer((req,res)=>res.end('child alive')).listen(process.env.PORT,process.env.HOST);`);
    await writeFile(join(published, 'server.mjs'), `import {spawn} from 'node:child_process';
spawn(process.execPath,['child.mjs'],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
    const started = await manager.start(spec);
    expect(started.state).toBe('healthy');
    expect(await (await fetch(started.url + '/health')).text()).toBe('child alive');
    expect((await manager.stop(spec.serviceId)).state).toBe('stopped');
    await expect(fetch(started.url + '/health')).rejects.toThrow();
  }, 10000);

  it('keeps loopback binding and port under the persisted service specification', async () => {
    const { spec } = await fixture();
    for (const serviceId of [undefined, null, 123, {}, '']) {
      expect(() => validateLocalServiceSpecification({ ...spec, serviceId })).toThrow();
    }
    for (const key of ['HOST', 'PORT']) {
      expect(() => validateLocalServiceSpecification({ ...spec, environmentReferences: { [key]: 'vault:override' } })).toThrow();
    }
  });
  it('starts published code once, answers real HTTP, recovers after Server replacement, stops and restarts', async () => {
    const { manager, spec, deps, published } = await fixture();
    expect(await manager.readSpecification('task')).toEqual(spec);
    const [first, repeated] = await Promise.all([manager.start(spec), manager.start(spec)]);
    expect(first.state).toBe('healthy'); expect(repeated.state).toBe('healthy');
    const processId = manager.find('backend')!.processId;
    expect((await fetch(first.url + '/health')).status).toBe(200);
    expect(await manager.logs('backend')).toContain(published);
    const recovered = new ManagedLocalServices(deps);
    await recovered.recover();
    expect((await recovered.status('backend')).state).toBe('healthy');
    await recovered.start(spec);
    expect(recovered.find('backend')!.processId).toBe(processId);
    expect(JSON.stringify(first)).not.toContain(String(processId));
    expect((await recovered.stop('backend')).state).toBe('stopped');
    await expect(fetch(first.url + '/health')).rejects.toThrow();
    expect((await recovered.restart('backend')).state).toBe('healthy');
    expect(recovered.find('backend')!.processId).not.toBe(processId);
  }, 15000);

  it('records a bounded startup timeout as a definite failure and stops the process', async () => {
    const { manager, spec } = await fixture('/missing');
    const result = await manager.start(spec);
    // Health never passed inside startupTimeoutMs: the task-owned start is a
    // definite failure and its process is stopped, never left half-running.
    expect(result.state).toBe('failed');
    expect(result.message).toBe('service_health_timeout');
    expect(manager.find('backend')?.processId ?? null).toBeNull();
  });

  it('refuses an occupied port and an unpublished task', async () => {
    const { manager, spec, deps } = await fixture();
    await manager.start(spec);
    // Publication refusal is checked with a fresh service ID, before any command runs.
    const unavailable = new ManagedLocalServices({ ...deps, resolvePublishedDirectory: async () => null });
    await expect(unavailable.start({ ...spec, serviceId: 'unpublished', port: spec.port + 1 })).rejects.toThrow('尚未发布');
    await expect(manager.start({ ...spec, serviceId: 'occupied' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});


describe('durable authorized service operations', () => {
  it('serializes two Runtime managers and replays a restart decision without a second launch', async () => {
    const { manager, spec, deps } = await fixture();
    const replacement = new ManagedLocalServices(deps);
    await Promise.all([manager.start(spec), replacement.start(spec)]);
    const first = manager.find(spec.serviceId)!.processId;
    const request = { decisionId: 'restart-once', operation: 'restart' as const, serviceId: spec.serviceId };
    const result = await manager.applyAuthorizedOperation(request);
    const restarted = manager.find(spec.serviceId)!;
    expect(result.result?.state).toBe('healthy');
    expect(restarted.processId).not.toBe(first);
    expect(await replacement.applyAuthorizedOperation(request)).toEqual(result);
    expect(replacement.find(spec.serviceId)!.processId).toBe(restarted.processId);
    // Simulate loss of the final journal write after the process was launched.
    deps.store.saveOperation({ ...result, phase: 'starting', initialToken: null, result: null });
    expect((await replacement.applyAuthorizedOperation(request)).result?.state).toBe('healthy');
    expect(replacement.find(spec.serviceId)!.processId).toBe(restarted.processId);
  }, 15000);

  it('survives actual Server process exit and is rediscovered without spawning again', async () => {
    const { manager, spec, deps, root, published } = await fixture();
    // Compile only the Runtime adapter for a real, independent Server process.
    for (const source of ['core/local-service-revision', 'execution/managed-local-service', 'storage/managed-local-service-repo', 'task/local-service', 'utils/public-text', 'utils/redact-sensitive-text']) {
      const target = join(root, 'compiled', source + '.js');
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, ts.transpileModule(await readFile(join(process.cwd(), 'src', source + '.ts'), 'utf8'),
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
    }
    await writeFile(join(root, 'compiled', 'package.json'), '{"type":"module"}');
    const script = join(root, 'compiled', 'server.mjs');
    await writeFile(script, `import Database from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'node_modules/better-sqlite3/lib/index.js')).href)};
import { ManagedLocalServices } from './execution/managed-local-service.js';
import { ManagedLocalServiceRepo } from './storage/managed-local-service-repo.js';
const db = new Database(${JSON.stringify(join(root, 'state.db'))});
const manager = new ManagedLocalServices({ accountId: 'local-default', store: new ManagedLocalServiceRepo(db, 'local-default'),
logRoot: ${JSON.stringify(deps.logRoot)}, resolvePublishedDirectory: async () => ${JSON.stringify(published)}, resolveEnvironment: async () => null });
const result = await manager.applyAuthorizedOperation(${JSON.stringify({ decisionId: 'server-start', serviceId: spec.serviceId, operation: 'start', specification: spec })});
console.log(JSON.stringify(result)); db.close(); process.exit(0);`);
    const { stdout } = await promisify(execFile)(process.execPath, [script]);
    expect(JSON.parse(stdout).result.state).toBe('healthy');
    const pid = manager.find(spec.serviceId)!.processId;
    await manager.recover();
    expect((await manager.status(spec.serviceId)).state).toBe('healthy');
    expect((await manager.applyAuthorizedOperation({ decisionId: 'server-start', serviceId: spec.serviceId,
      operation: 'start', specification: spec })).result?.state).toBe('healthy');
    expect(manager.find(spec.serviceId)!.processId).toBe(pid);
    expect((await manager.stop(spec.serviceId)).state).toBe('stopped');
  }, 15000);

  it('records a failed command truthfully and does not silently retry a completed decision', async () => {
    const { manager, spec } = await fixture();
    const request = { decisionId: 'failed-start', operation: 'start' as const, serviceId: spec.serviceId,
      specification: { ...spec, command: 'metawork-command-that-does-not-exist' } };
    const result = await manager.applyAuthorizedOperation(request);
    expect(result.result?.state).toBe('failed');
    const token = manager.find(spec.serviceId)!.processToken;
    expect(await manager.applyAuthorizedOperation(request)).toEqual(result);
    expect(manager.find(spec.serviceId)!.processToken).toBe(token);
  });

  it('persists an explicitly authorized specification update after the service is stopped', async () => {
    const { manager, spec } = await fixture();
    await manager.start(spec);
    await manager.stop(spec.serviceId);
    const changed = { ...spec, args: ['updated-server.mjs'] };
    const result = await manager.applyAuthorizedOperation({
      decisionId: 'update-once',
      operation: 'update',
      serviceId: spec.serviceId,
      specification: changed,
    });
    expect(result.error).toBeNull();
    expect(manager.find(spec.serviceId)?.specification).toEqual(changed);
    expect(manager.find(spec.serviceId)?.specificationRevision).toBe(localServiceSpecificationRevision(changed));
    expect(manager.find(spec.serviceId)?.state).toBe('stopped');
  });

  it('redacts referenced secrets and internal paths in service logs', async () => {
    const { spec, deps, published } = await fixture();
    await writeFile(join(published, 'server.mjs'), `console.log(process.env.SERVICE_SECRET);console.log('/private/runtime/workspace-store/workspaces/task/attempts/run/log');
import http from 'node:http';http.createServer((req,res)=>res.end('ok')).listen(process.env.PORT,process.env.HOST);`);
    const manager = new ManagedLocalServices({ ...deps, resolveEnvironment: async () => 'sensitive-test-value' });
    await manager.start({ ...spec, environmentReferences: { SERVICE_SECRET: 'vault:test' } });
    const logs = await manager.logs(spec.serviceId);
    expect(logs).not.toContain('sensitive-test-value'); expect(logs).not.toContain('workspace-store');
    expect(logs).toContain('[内部路径]');
  });
});

describe('service identity and current-specification precedence', () => {
  it('starts the current specification again after an earlier round recorded failure', async () => {
    const { manager, spec, published } = await fixture();
    // The first round's code exits immediately: the record becomes `failed`.
    await writeFile(join(published, 'server.mjs'), 'process.exit(1);');
    const failed = await manager.start(spec);
    expect(failed.state).toBe('failed');
    expect(manager.find(spec.serviceId)!.state).toBe('failed');
    // The same Workspace/service specification is now startable: a historical
    // `failed` fact is diagnosis input, never a blocker for the current round.
    await writeFile(join(published, 'server.mjs'), `import http from 'node:http';
http.createServer((req,res)=>{res.statusCode=req.url==='/health'?200:503;res.end('ready');}).listen(process.env.PORT,process.env.HOST);`);
    const restarted = await manager.start(spec);
    expect(restarted.state).toBe('healthy');
    expect((await fetch(restarted.url + '/health')).status).toBe(200);
    await manager.stop(spec.serviceId);
  }, 15000);

  it('keeps the same service id separate per Workspace', async () => {
    const { manager, spec, deps, root } = await fixture();
    const secondPublished = join(root, 'second-workspace', 'backend');
    await mkdir(secondPublished, { recursive: true });
    const secondPort = await new Promise<number>(accept => {
      const probe = createServer(); probe.listen(0, '127.0.0.1', () => {
        const address = probe.address(); const value = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => accept(value));
      });
    });
    const secondSpec: LocalServiceSpecification = {
      ...spec, taskId: 'task-2', port: secondPort, args: ['second.mjs'],
    };
    await writeFile(join(secondPublished, 'second.mjs'), `import http from 'node:http';
http.createServer((req,res)=>{res.statusCode=req.url==='/health'?200:503;res.end('ready');}).listen(process.env.PORT,process.env.HOST);`);
    await writeFile(join(secondPublished, '.metawork-service.json'), JSON.stringify(secondSpec));
    const db = new Database(join(root, 'state.db'));
    db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('task-2', 'Service', 'Service', 'succeeded', 'now', 'now')").run();
    db.close();
    const secondWorkspaceManager = new ManagedLocalServices({
      ...deps,
      workspaceId: 'workspace-second',
      resolvePublishedDirectory: async taskId => taskId === 'task-2' ? secondPublished : null,
    });
    const firstWorkspaceManager = new ManagedLocalServices({ ...deps, workspaceId: 'workspace-first' });

    const first = await firstWorkspaceManager.start(spec);
    const second = await secondWorkspaceManager.start(secondSpec);
    expect(first.state).toBe('healthy');
    expect(second.state).toBe('healthy');
    expect(first.url).not.toBe(second.url);
    // Both Workspace identities are readable from the same shared store, and
    // each resolves to its own specification and process.
    expect(firstWorkspaceManager.findForWorkspace('workspace-first', 'backend')?.specification.port).toBe(spec.port);
    expect(secondWorkspaceManager.findForWorkspace('workspace-second', 'backend')?.specification.port)
      .toBe(secondPort);
    await firstWorkspaceManager.stop('backend');
    await secondWorkspaceManager.stop('backend');
  }, 20000);

  it('reports bounded diagnostics for the current specification without exposing them publicly', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'server.mjs'), `import http from 'node:http';
http.createServer((req,res)=>{res.statusCode=req.url==='/health'?200:503;res.end('ready');}).listen(process.env.PORT,process.env.HOST);
console.log('boot diagnostics line');
setTimeout(() => process.exit(3), 1500);`);
    const started = await manager.start(spec);
    expect(started.state).toBe('healthy');
    await expect.poll(async () => (await manager.observe(spec.serviceId)).view.state, { timeout: 6000 })
      .toBe('failed');
    const observation = await manager.observe(spec.serviceId);
    expect(observation.diagnostics.exitObserved).toBe(true);
    expect(observation.diagnostics.retryable).toBe(true);
    // The last real answer of this contract (200) stays visible; the exit fact
    // is what makes the service failed.
    expect(observation.diagnostics.healthStatus).toBe(200);
    expect(observation.diagnostics.logTail).toContain('boot diagnostics line');
    expect(observation.diagnostics.specificationRevision)
      .toBe(localServiceSpecificationRevision(spec));
    // The public view keeps its contract: no process identity leaks out.
    expect(JSON.stringify(observation.view)).not.toContain(String(observation.diagnostics.processId));
    expect(Object.keys(observation.view).sort()).toEqual(
      ['message', 'serviceId', 'state', 'taskId', 'url'],
    );
  }, 15000);
});

describe('service specification handover across Tasks', () => {
  it('lets a later Task in the same Workspace take over the manifest an earlier Task wrote', async () => {
    const { manager, spec, root } = await fixture();
    // The current Task must exist: service ownership is a real Task handover.
    const db = new Database(join(root, 'state.db'));
    db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('task-later', 'Later', 'Later', 'running', 'now', 'now')").run();
    db.close();
    // Task `task` authored the manifest and registered the contract.
    await manager.start(spec);
    await manager.stop(spec.serviceId);
    expect(manager.find(spec.serviceId)?.specification.taskId).toBe('task');

    // A later Task in the same in-place Workspace reads the same manifest and
    // asks for the same service. Authoring provenance moves to the current
    // Task instead of blocking the launch.
    const later = { ...spec, taskId: 'task-later' };
    await expect(manager.readSpecification('task-later')).resolves.toEqual(later);
    const started = await manager.start(later);
    expect(started.state).toBe('healthy');
    expect(manager.find(spec.serviceId)?.specification.taskId).toBe('task-later');
    expect(manager.find(spec.serviceId)?.specificationRevision)
      .toBe(localServiceSpecificationRevision(later));
    await manager.stop(spec.serviceId);
  }, 15000);

  it('hands a live process over to the current Task without relaunching it', async () => {
    const { manager, spec, root } = await fixture();
    const running = await manager.start(spec);
    const processId = manager.find(spec.serviceId)?.processId;
    const db = new Database(join(root, 'state.db'));
    db.prepare("INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('task-live', 'Live', 'Live', 'running', 'now', 'now')").run();
    db.close();
    const later = { ...spec, taskId: 'task-live' };
    const observed = await manager.start(later);
    expect(observed.state).toBe('healthy');
    // Same process, new owner: the launch contract did not change.
    expect(manager.find(spec.serviceId)?.processId).toBe(processId);
    expect(manager.find(spec.serviceId)?.specification.taskId).toBe('task-live');
    expect((await fetch(running.url + '/health')).status).toBe(200);
    await manager.stop(spec.serviceId);
  }, 15000);

  it('still rejects a manifest whose contract this Workspace never registered', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'other.mjs'), 'process.exit(0);');
    const foreign = { ...spec, taskId: 'task-foreign', args: ['other.mjs'], port: spec.port + 1 };
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(foreign));
    await expect(manager.readSpecification('task')).rejects.toThrow('服务规格不属于当前任务');
  });
});

describe('service acceptance matrix (§9.2)', () => {
  it('starts a stopped service again on an explicit start', async () => {
    const { manager, spec } = await fixture();
    expect((await manager.start(spec)).state).toBe('healthy');
    expect((await manager.stop(spec.serviceId)).state).toBe('stopped');
    // A `stopped` record is a fact, not a refusal: the current specification
    // starts again on an explicit request.
    const restarted = await manager.start(spec);
    expect(restarted.state).toBe('healthy');
    expect((await fetch(restarted.url + '/health')).status).toBe(200);
    await manager.stop(spec.serviceId);
  }, 15000);

  it('binds a changed specification only through the authorized update', async () => {
    const { manager, spec, deps, published, root } = await fixture();
    await manager.start(spec);
    await manager.stop(spec.serviceId);
    const secondPort = await new Promise<number>(accept => {
      const probe = createServer(); probe.listen(0, '127.0.0.1', () => {
        const address = probe.address(); const value = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => accept(value));
      });
    });
    const changed: LocalServiceSpecification = { ...spec, port: secondPort };
    await writeFile(join(published, '.metawork-service.json'), JSON.stringify(changed));
    // Without the update authorization the changed launch contract is refused.
    await expect(manager.readSpecification(spec.taskId)).rejects.toThrow('需要显式的服务更新授权');
    // The Kernel-authorized update binds the new revision, then the start uses it.
    const updated = await manager.applyAuthorizedOperation({
      decisionId: 'authorized-update',
      operation: 'update',
      serviceId: spec.serviceId,
      specification: await manager.readSpecification(spec.taskId, { allowRevisionChange: true }),
      workspaceId: '',
    });
    expect(updated.error).toBeNull();
    const started = await manager.start(changed);
    expect(started.state).toBe('healthy');
    expect(started.url).toContain(`:${secondPort}`);
    expect((await fetch(started.url + '/health')).status).toBe(200);
    expect(manager.find(spec.serviceId)?.specificationRevision)
      .toBe(localServiceSpecificationRevision(changed));
    expect(root).toBeTruthy();
    expect(deps.accountId).toBe('local-default');
    await manager.stop(spec.serviceId);
  }, 20000);

  it('never reports a failing health check as success and keeps the real status', async () => {
    const { manager, spec, published } = await fixture();
    await writeFile(join(published, 'server.mjs'), `import http from 'node:http';
http.createServer((req,res)=>{res.statusCode=503;res.end('not ready');}).listen(process.env.PORT,process.env.HOST);`);
    const started = await manager.start(spec);
    // A 503 never becomes `healthy`; the start window ends as a definite failure.
    expect(started.state).toBe('failed');
    expect(started.message).toBe('service_health_timeout');
    const observation = await manager.observe(spec.serviceId);
    // The real HTTP answer survives for the repair round instead of being lost.
    expect(observation.diagnostics.healthStatus).toBe(503);
    expect(observation.diagnostics.retryable).toBe(true);
  }, 15000);
});
